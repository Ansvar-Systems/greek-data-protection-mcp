#!/usr/bin/env tsx
/**
 * HDPA ingestion crawler — fetches decisions and guidelines from dpa.gr.
 *
 * Two-phase pipeline:
 *   Phase 1 (Index):   Paginate the "Πράξεις της Αρχής" listing to build a
 *                       metadata index (reference, title, date, category, URL).
 *   Phase 2 (Content): Fetch each detail page, extract full text and metadata,
 *                       upsert into the SQLite database.
 *
 * The site is Drupal-based. Greek-language pages carry full content;
 * English pages exist for a small subset only. The crawler hits the Greek
 * listing at /el/enimerwtiko/prakseisArxis and falls back to English where
 * an English slug is available.
 *
 * Usage:
 *   npx tsx scripts/ingest-hdpa.ts
 *   npx tsx scripts/ingest-hdpa.ts --resume
 *   npx tsx scripts/ingest-hdpa.ts --dry-run
 *   npx tsx scripts/ingest-hdpa.ts --force
 *   npx tsx scripts/ingest-hdpa.ts --limit 50
 *   npx tsx scripts/ingest-hdpa.ts --page-start 10 --page-end 20
 *   npx tsx scripts/ingest-hdpa.ts --resume --limit 100
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env["HDPA_DB_PATH"] ?? "data/hdpa.db";
const DATA_DIR = resolve(__dirname, "..", "data");
const INDEX_PATH = resolve(DATA_DIR, "hdpa-index.json");
const PROGRESS_PATH = resolve(DATA_DIR, "hdpa-progress.json");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://www.dpa.gr";
const LISTING_PATH = "/el/enimerwtiko/prakseisArxis";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const USER_AGENT =
  "AnsvarHDPACrawler/1.0 (+https://ansvar.eu; data-protection-research)";

/**
 * Map Greek category labels to normalised English types used in the DB.
 */
const CATEGORY_MAP: Record<string, string> = {
  "Απόφαση": "decision",
  "Γνωμοδότηση": "opinion",
  "Οδηγία": "directive",
  "Σύσταση": "recommendation",
  "Κανονιστική Πράξη": "regulatory_act",
  "Πράξη": "act",
  // English variants (from /en pages)
  "Decision": "decision",
  "Opinion": "opinion",
  "Directive": "directive",
  "Recommendation": "recommendation",
};

/**
 * Map Greek thematic labels to topic IDs matching the `topics` table.
 */
const THEMATIC_TO_TOPIC: Record<string, string> = {
  "Ηλεκτρονικές επικοινωνίες": "cookies",
  "Υπηρεσίες ηλεκτρονικής επικοινωνίας": "cookies",
  "Βιντεοεπιτήρηση": "cctv",
  "Υγεία": "health_data",
  "Εκπαίδευση": "children",
  "Δικαιώματα υποκειμένων": "consent",
  "Ασφάλεια δεδομένων": "breach_notification",
  "Εκτίμηση αντικτύπου": "dpia",
  "Διαβίβαση δεδομένων": "transfers",
  "Εργασιακά": "consent",
  "Πολιτική επικοινωνία": "consent",
  "Δημόσιος τομέας": "privacy_by_design",
};

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

interface CliFlags {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
  limit: number;
  pageStart: number;
  pageEnd: number;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = {
    resume: false,
    dryRun: false,
    force: false,
    limit: 0,
    pageStart: 0,
    pageEnd: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--resume":
        flags.resume = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "--limit":
        flags.limit = parseInt(args[++i] ?? "0", 10);
        break;
      case "--page-start":
        flags.pageStart = parseInt(args[++i] ?? "0", 10);
        break;
      case "--page-end":
        flags.pageEnd = parseInt(args[++i] ?? "0", 10);
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES,
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "el,en;q=0.5",
        },
        redirect: "follow",
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }

      return await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        const delay = RETRY_BACKOFF_MS * attempt;
        console.warn(
          `  WARN: attempt ${attempt}/${retries} failed for ${url}: ${msg} — retrying in ${delay}ms`,
        );
        await sleep(delay);
      } else {
        throw new Error(
          `Failed after ${retries} attempts for ${url}: ${msg}`,
        );
      }
    }
  }

  // unreachable, but TypeScript needs this
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Index entry
// ---------------------------------------------------------------------------

interface IndexEntry {
  /** Normalised reference: e.g. "HDPA-2022-35" */
  reference: string;
  /** Title from listing row */
  title: string;
  /** ISO date: YYYY-MM-DD */
  date: string;
  /** Greek category label from listing */
  categoryRaw: string;
  /** Number column from listing */
  number: string;
  /** Relative URL to detail page */
  detailPath: string;
}

// ---------------------------------------------------------------------------
// Phase 1: Index — paginate the listing
// ---------------------------------------------------------------------------

function buildListingUrl(page: number): string {
  const params = new URLSearchParams({
    field_year_from: "",
    field_year_to: "",
    field_category: "All",
    field_thematic: "All",
    field_protocol_number: "",
    field_keywords: "",
    page: String(page),
  });
  return `${BASE_URL}${LISTING_PATH}?${params.toString()}`;
}

/**
 * Parse a single listing page and return index entries.
 */
function parseListingPage(html: string): IndexEntry[] {
  const $ = cheerio.load(html);
  const entries: IndexEntry[] = [];

  // The listing uses a <table> (within the view results).
  // Each <tr> has 4 <td>: category | number | date | title (with link).
  $("table tbody tr, table tr").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 4) return;

    const categoryRaw = $(cells[0]).text().trim();
    const number = $(cells[1]).text().trim();
    const dateRaw = $(cells[2]).text().trim();
    const titleCell = $(cells[3]);
    const link = titleCell.find("a");
    const title = link.text().trim() || titleCell.text().trim();
    const detailPath = link.attr("href") ?? "";

    if (!title || !detailPath) return;

    // Parse DD/MM/YYYY to YYYY-MM-DD
    const date = parseDateDMY(dateRaw);

    // Build normalised reference: "HDPA-YYYY-NNN"
    const year = date ? date.slice(0, 4) : "0000";
    const ref = `HDPA-${year}-${number.replace(/\D/g, "") || "0"}`;

    entries.push({
      reference: ref,
      title,
      date: date || "",
      categoryRaw,
      number,
      detailPath,
    });
  });

  return entries;
}

/**
 * Check whether a next page exists by looking for a pager "next" link.
 */
function hasNextPage(html: string): boolean {
  const $ = cheerio.load(html);
  // Drupal pager: look for a "next" link (›) or "Επόμενο" text
  const nextLink = $("li.pager__item--next a, .pager a").filter((_i, el) => {
    const text = $(el).text();
    return text.includes("›") || text.includes("Επόμενο") || text.includes("Next");
  });
  return nextLink.length > 0;
}

/**
 * Extract total result count from the listing page, if available.
 */
function extractResultCount(html: string): number | null {
  // "Βρέθηκαν 2260 αποτελέσματα" or "Found 2260 results"
  const match = html.match(/(?:Βρέθηκαν|Found)\s+([\d.,]+)\s+(?:αποτελέσματα|results)/i);
  if (match?.[1]) {
    return parseInt(match[1].replace(/[.,]/g, ""), 10);
  }
  return null;
}

async function runIndexPhase(flags: CliFlags): Promise<IndexEntry[]> {
  console.log("\n=== Phase 1: Index — paginate dpa.gr listing ===\n");

  const allEntries: IndexEntry[] = [];
  let page = flags.pageStart;
  let totalResults: number | null = null;
  let emptyPages = 0;
  const maxEmptyPages = 3; // stop after 3 consecutive empty pages

  while (true) {
    if (flags.pageEnd > 0 && page > flags.pageEnd) {
      console.log(`  Reached --page-end ${flags.pageEnd}, stopping index.`);
      break;
    }

    const url = buildListingUrl(page);
    console.log(`  Page ${page}: ${url}`);

    let html: string;
    try {
      html = await fetchWithRetry(url);
    } catch (err) {
      console.error(
        `  ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }

    // Extract total count on first page
    if (page === flags.pageStart) {
      totalResults = extractResultCount(html);
      if (totalResults !== null) {
        console.log(`  Total results reported: ${totalResults}`);
      }
    }

    const entries = parseListingPage(html);
    if (entries.length === 0) {
      emptyPages++;
      if (emptyPages >= maxEmptyPages) {
        console.log(`  ${maxEmptyPages} consecutive empty pages — end of listing.`);
        break;
      }
    } else {
      emptyPages = 0;
    }

    allEntries.push(...entries);
    console.log(`  Page ${page}: ${entries.length} entries (cumulative: ${allEntries.length})`);

    if (flags.limit > 0 && allEntries.length >= flags.limit) {
      console.log(`  Reached --limit ${flags.limit}, stopping index.`);
      break;
    }

    if (!hasNextPage(html)) {
      console.log("  No next page link — end of listing.");
      break;
    }

    page++;
    await sleep(RATE_LIMIT_MS);
  }

  // Deduplicate by reference (keep first occurrence)
  const seen = new Set<string>();
  const deduped: IndexEntry[] = [];
  for (const entry of allEntries) {
    const key = `${entry.reference}::${entry.detailPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(entry);
    }
  }

  if (flags.limit > 0) {
    deduped.splice(flags.limit);
  }

  // Persist index
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(deduped, null, 2));
  console.log(`\n  Saved ${deduped.length} index entries to ${INDEX_PATH}`);

  return deduped;
}

// ---------------------------------------------------------------------------
// Phase 2: Content — fetch detail pages and upsert
// ---------------------------------------------------------------------------

interface ParsedDetail {
  title: string;
  bodyText: string;
  /** Any summary paragraph extracted from structured fields */
  summary: string;
  /** Fine amount extracted from text (EUR) */
  fineAmount: number | null;
  /** Entity name extracted from text */
  entityName: string | null;
  /** GDPR articles mentioned */
  gdprArticles: string[];
  /** Topic IDs derived from thematic tags */
  topics: string[];
  /** PDF download URL, if present */
  pdfUrl: string | null;
}

function parseDetailPage(html: string): ParsedDetail {
  const $ = cheerio.load(html);

  // Title: Drupal uses .page-header or h1
  const title =
    $("h1.page-header span").text().trim() ||
    $("h1.page-header").text().trim() ||
    $("h1").first().text().trim();

  // Body: Drupal field--name-body
  let bodyText =
    $(".field--name-body").text().trim() ||
    $(".node__content .field").text().trim() ||
    $("article .content").text().trim();

  // If body is too short, grab all paragraph text from main content area
  if (bodyText.length < 100) {
    const paragraphs: string[] = [];
    $("article p, .content p, .node__content p").each((_i, el) => {
      const text = $(el).text().trim();
      if (text.length > 10) {
        paragraphs.push(text);
      }
    });
    if (paragraphs.length > 0) {
      bodyText = paragraphs.join("\n\n");
    }
  }

  // Summary: first substantial paragraph (> 50 chars)
  let summary = "";
  $(".field--name-body p, article p, .content p").each((_i, el) => {
    if (summary) return;
    const text = $(el).text().trim();
    if (text.length > 50) {
      summary = text;
    }
  });

  // Extract fine amount from text (EUR patterns)
  const fineAmount = extractFineAmount(bodyText || summary || title);

  // Extract entity name from title or body
  const entityName = extractEntityName(title, bodyText);

  // Extract GDPR articles
  const gdprArticles = extractGdprArticles(bodyText);

  // Extract topics from thematic tags on the page
  const topics: string[] = [];
  $("a[href*='field_thematic'], .field--name-field-thematic a").each(
    (_i, el) => {
      const label = $(el).text().trim();
      const topicId = THEMATIC_TO_TOPIC[label];
      if (topicId && !topics.includes(topicId)) {
        topics.push(topicId);
      }
    },
  );

  // PDF link
  let pdfUrl: string | null = null;
  $("a[href$='.pdf'], a[href*='.PDF']").each((_i, el) => {
    if (!pdfUrl) {
      const href = $(el).attr("href");
      if (href) {
        pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      }
    }
  });

  return { title, bodyText, summary, fineAmount, entityName, gdprArticles, topics, pdfUrl };
}

/**
 * Parse DD/MM/YYYY into YYYY-MM-DD. Returns empty string on failure.
 */
function parseDateDMY(raw: string): string {
  const match = raw.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (!match) return "";
  const [, day, month, year] = match;
  return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

/**
 * Extract a fine amount in EUR from text.
 * Handles: "EUR 20,000,000", "20.000 ευρώ", "πρόστιμο 30.000€", etc.
 */
function extractFineAmount(text: string): number | null {
  // Patterns: "EUR X", "X EUR", "X ευρώ", "X€", "πρόστιμο X"
  const patterns = [
    // "EUR 20,000,000" or "EUR 20.000.000"
    /EUR\s+([\d.,]+)/gi,
    // "20.000.000 EUR"
    /([\d.,]+)\s*EUR/gi,
    // "20.000 ευρώ" or "20.000,00 ευρώ"
    /([\d.,]+)\s*ευρώ/gi,
    // "20.000€"
    /([\d.,]+)\s*€/gi,
    // "fine of EUR X" (English)
    /fine\s+of\s+(?:EUR\s+)?([\d.,]+)/gi,
    // "πρόστιμο X" (Greek: fine X)
    /πρόστιμο\s+(?:ύψους\s+)?([\d.,]+)/gi,
    // "πρόστιμο ... ευρώ" broader match
    /πρόστιμο[^.]{0,80}?([\d.,]+)\s*(?:ευρώ|€|EUR)/gi,
  ];

  let best: number | null = null;

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      const parsed = parseEuropeanNumber(raw);
      if (parsed !== null && (best === null || parsed > best)) {
        best = parsed;
      }
    }
  }

  return best;
}

/**
 * Parse a European-format number: "20.000.000" or "20,000,000" or "30.000,00".
 */
function parseEuropeanNumber(raw: string): number | null {
  let cleaned = raw.trim();

  // If the number uses dots as thousands separators and comma as decimal
  // e.g. "20.000.000" or "30.000,50"
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  }
  // US-style: "20,000,000" or "20,000.50"
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, "");
  }
  // Plain integer with dots as thousand sep: "30.000"
  else if (/^\d{1,3}\.\d{3}$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "");
  }
  // Plain number
  else {
    cleaned = cleaned.replace(/,/g, "");
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Extract entity name from title patterns like "... — Entity Name" or
 * "Επιβολή προστίμου σε [entity]".
 */
function extractEntityName(
  title: string,
  body: string,
): string | null {
  // Pattern: "Decision — Entity Name"
  const dashMatch = title.match(/[—–-]\s*(.+?)(?:\s*\(|$)/);
  if (dashMatch?.[1] && dashMatch[1].length > 2) {
    return dashMatch[1].trim();
  }

  // Pattern: "... σε [entity]" (Greek: "... to [entity]")
  const seMatch = title.match(/\bσε\s+(.+?)(?:\s+για\b|\s+λόγω\b|$)/i);
  if (seMatch?.[1] && seMatch[1].length > 2) {
    return seMatch[1].trim();
  }

  // Pattern: entity mentioned early in body after "κατά" (against)
  const kataMatch = body.match(/κατά\s+(?:της?\s+)?(.+?)(?:\s+για\b|[.,])/i);
  if (kataMatch?.[1] && kataMatch[1].length > 2 && kataMatch[1].length < 100) {
    return kataMatch[1].trim();
  }

  return null;
}

/**
 * Extract GDPR article numbers from text.
 * Matches: "Art. 5", "Article 6(1)(a)", "άρθρο 35 ΓΚΠΔ", "Αρ. 9", etc.
 */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // English patterns
  const enPattern = /\b(?:Art(?:icle)?\.?\s*)(\d{1,3})/gi;
  let match: RegExpExecArray | null;
  while ((match = enPattern.exec(text)) !== null) {
    if (match[1]) articles.add(match[1]);
  }

  // Greek patterns: "άρθρο 35" or "άρθρου 35" or "Αρ. 5"
  const elPattern = /\b(?:άρθρ(?:ο|ου|ων|α)|Αρ\.?)\s*(\d{1,3})/gi;
  while ((match = elPattern.exec(text)) !== null) {
    if (match[1]) articles.add(match[1]);
  }

  // Filter to plausible GDPR article numbers (1–99)
  return Array.from(articles)
    .filter((n) => {
      const num = parseInt(n, 10);
      return num >= 1 && num <= 99;
    })
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/**
 * Classify an index entry as a "decision" (for decisions table) or
 * "guideline" (for guidelines table) based on category.
 */
function classifyEntry(
  categoryRaw: string,
): "decision" | "guideline" {
  const type = CATEGORY_MAP[categoryRaw] ?? categoryRaw.toLowerCase();
  if (
    type === "directive" ||
    type === "recommendation" ||
    type === "guideline" ||
    type === "circular"
  ) {
    return "guideline";
  }
  return "decision";
}

// ---------------------------------------------------------------------------
// Progress tracking (for --resume)
// ---------------------------------------------------------------------------

interface ProgressState {
  completedRefs: string[];
  lastUpdated: string;
}

function loadProgress(): ProgressState {
  if (existsSync(PROGRESS_PATH)) {
    try {
      return JSON.parse(readFileSync(PROGRESS_PATH, "utf-8")) as ProgressState;
    } catch {
      // corrupted file — start fresh
    }
  }
  return { completedRefs: [], lastUpdated: new Date().toISOString() };
}

function saveProgress(state: ProgressState): void {
  state.lastUpdated = new Date().toISOString();
  writeFileSync(PROGRESS_PATH, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function openDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function upsertDecision(
  db: Database.Database,
  entry: IndexEntry,
  detail: ParsedDetail,
): void {
  const type = CATEGORY_MAP[entry.categoryRaw] ?? "decision";

  db.prepare(
    `INSERT INTO decisions
       (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
     VALUES
       (@reference, @title, @date, @type, @entity_name, @fine_amount, @summary, @full_text, @topics, @gdpr_articles, @status)
     ON CONFLICT(reference) DO UPDATE SET
       title        = @title,
       date         = @date,
       type         = @type,
       entity_name  = COALESCE(@entity_name, decisions.entity_name),
       fine_amount  = COALESCE(@fine_amount, decisions.fine_amount),
       summary      = @summary,
       full_text    = @full_text,
       topics       = @topics,
       gdpr_articles= @gdpr_articles,
       status       = @status`,
  ).run({
    reference: entry.reference,
    title: detail.title || entry.title,
    date: entry.date || null,
    type,
    entity_name: detail.entityName ?? null,
    fine_amount: detail.fineAmount ?? null,
    summary: detail.summary || null,
    full_text: detail.bodyText || entry.title,
    topics: detail.topics.length > 0 ? JSON.stringify(detail.topics) : null,
    gdpr_articles:
      detail.gdprArticles.length > 0
        ? JSON.stringify(detail.gdprArticles)
        : null,
    status: "final",
  });
}

function upsertGuideline(
  db: Database.Database,
  entry: IndexEntry,
  detail: ParsedDetail,
): void {
  const type = CATEGORY_MAP[entry.categoryRaw] ?? "guideline";

  // Check if a guideline with same reference already exists
  const existing = db
    .prepare("SELECT id FROM guidelines WHERE reference = ?")
    .get(entry.reference) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE guidelines SET
         title     = @title,
         date      = @date,
         type      = @type,
         summary   = @summary,
         full_text = @full_text,
         topics    = @topics,
         language  = @language
       WHERE reference = @reference`,
    ).run({
      reference: entry.reference,
      title: detail.title || entry.title,
      date: entry.date || null,
      type,
      summary: detail.summary || null,
      full_text: detail.bodyText || entry.title,
      topics: detail.topics.length > 0 ? JSON.stringify(detail.topics) : null,
      language: "el",
    });
  } else {
    db.prepare(
      `INSERT INTO guidelines
         (reference, title, date, type, summary, full_text, topics, language)
       VALUES
         (@reference, @title, @date, @type, @summary, @full_text, @topics, @language)`,
    ).run({
      reference: entry.reference,
      title: detail.title || entry.title,
      date: entry.date || null,
      type,
      summary: detail.summary || null,
      full_text: detail.bodyText || entry.title,
      topics: detail.topics.length > 0 ? JSON.stringify(detail.topics) : null,
      language: "el",
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Content fetch + upsert
// ---------------------------------------------------------------------------

async function runContentPhase(
  entries: IndexEntry[],
  flags: CliFlags,
): Promise<void> {
  console.log("\n=== Phase 2: Content — fetch detail pages and upsert ===\n");

  if (flags.dryRun) {
    console.log("  DRY RUN — no database writes will occur.\n");
  }

  const db = flags.dryRun ? null : openDb(flags.force);

  // Load resume state
  const progress = flags.resume ? loadProgress() : { completedRefs: [], lastUpdated: "" };
  const completedSet = new Set(progress.completedRefs);

  let fetched = 0;
  let skipped = 0;
  let errors = 0;
  let decisionsInserted = 0;
  let guidelinesInserted = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const key = `${entry.reference}::${entry.detailPath}`;

    // Skip if already completed (--resume)
    if (flags.resume && completedSet.has(key)) {
      skipped++;
      continue;
    }

    // Rate limit
    if (fetched > 0) {
      await sleep(RATE_LIMIT_MS);
    }

    const detailUrl = entry.detailPath.startsWith("http")
      ? entry.detailPath
      : `${BASE_URL}${entry.detailPath}`;

    console.log(
      `  [${i + 1}/${entries.length}] ${entry.reference} — ${entry.title.slice(0, 60)}...`,
    );

    let html: string;
    try {
      html = await fetchWithRetry(detailUrl);
      fetched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ERROR fetching: ${msg}`);
      errors++;
      continue;
    }

    const detail = parseDetailPage(html);
    const table = classifyEntry(entry.categoryRaw);

    if (detail.bodyText.length < 20) {
      console.warn(
        `    WARN: body too short (${detail.bodyText.length} chars), may be a stub page.`,
      );
    }

    if (flags.dryRun) {
      console.log(
        `    [dry-run] ${table} | fine=${detail.fineAmount ?? "none"} | ` +
          `entity=${detail.entityName ?? "none"} | ` +
          `gdpr=[${detail.gdprArticles.join(",")}] | ` +
          `topics=[${detail.topics.join(",")}] | ` +
          `body=${detail.bodyText.length} chars`,
      );
    } else {
      try {
        if (table === "decision") {
          upsertDecision(db!, entry, detail);
          decisionsInserted++;
        } else {
          upsertGuideline(db!, entry, detail);
          guidelinesInserted++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    ERROR inserting: ${msg}`);
        errors++;
        continue;
      }
    }

    // Track progress
    completedSet.add(key);
    progress.completedRefs = Array.from(completedSet);

    // Save progress every 25 entries
    if (!flags.dryRun && fetched % 25 === 0) {
      saveProgress(progress);
    }
  }

  // Final progress save
  if (!flags.dryRun) {
    saveProgress(progress);
  }

  if (db) {
    // Print counts
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const guidelineCount = (
      db.prepare("SELECT count(*) as cnt FROM guidelines").get() as {
        cnt: number;
      }
    ).cnt;

    db.close();

    console.log(`\n  Content phase complete.`);
    console.log(`    Fetched:    ${fetched}`);
    console.log(`    Skipped:    ${skipped} (already completed)`);
    console.log(`    Errors:     ${errors}`);
    console.log(`    Decisions:  ${decisionsInserted} upserted (total in DB: ${decisionCount})`);
    console.log(`    Guidelines: ${guidelinesInserted} upserted (total in DB: ${guidelineCount})`);
  } else {
    console.log(`\n  Dry run complete.`);
    console.log(`    Would fetch: ${fetched}`);
    console.log(`    Skipped:     ${skipped}`);
    console.log(`    Errors:      ${errors}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags();

  console.log("HDPA Ingestion Crawler");
  console.log("======================");
  console.log(`  Database:    ${DB_PATH}`);
  console.log(`  Dry run:     ${flags.dryRun}`);
  console.log(`  Resume:      ${flags.resume}`);
  console.log(`  Force:       ${flags.force}`);
  console.log(`  Limit:       ${flags.limit || "none"}`);
  console.log(`  Page range:  ${flags.pageStart}–${flags.pageEnd || "end"}`);

  // Phase 1: build or load index
  let index: IndexEntry[];

  if (flags.resume && existsSync(INDEX_PATH)) {
    console.log(`\n  Loading cached index from ${INDEX_PATH}...`);
    index = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as IndexEntry[];
    console.log(`  Loaded ${index.length} entries from cache.`);
  } else {
    index = await runIndexPhase(flags);
  }

  if (index.length === 0) {
    console.log("\n  No entries found. Nothing to do.");
    return;
  }

  // Apply limit to content phase
  if (flags.limit > 0 && index.length > flags.limit) {
    index = index.slice(0, flags.limit);
  }

  // Phase 2: fetch detail pages and upsert
  await runContentPhase(index, flags);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(
    `\nFatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
