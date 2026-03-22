/**
 * Seed the HDPA database with sample decisions and guidelines for testing.
 *
 * Includes real HDPA decisions (Clearview AI, Kalamata Municipality, Wind Hellas)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["HDPA_DB_PATH"] ?? "data/hdpa.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

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

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_el: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  {
    id: "consent",
    name_el: "Συγκατάθεση",
    name_en: "Consent",
    description: "Collection, validity and withdrawal of consent for personal data processing (Art. 7 GDPR).",
  },
  {
    id: "cookies",
    name_el: "Cookies και ιχνηλάτες",
    name_en: "Cookies and trackers",
    description: "Placement and reading of cookies and trackers on user devices (Art. 5(3) ePrivacy Directive).",
  },
  {
    id: "transfers",
    name_el: "Διεθνείς μεταφορές",
    name_en: "International transfers",
    description: "Transfers of personal data to third countries or international organisations (Art. 44–49 GDPR).",
  },
  {
    id: "dpia",
    name_el: "Εκτίμηση Αντικτύπου (DPIA)",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description: "Assessment of risks to rights and freedoms for high-risk processing (Art. 35 GDPR).",
  },
  {
    id: "breach_notification",
    name_el: "Παραβίαση δεδομένων",
    name_en: "Data breach notification",
    description: "Notification of data breaches to the HDPA and data subjects (Art. 33–34 GDPR).",
  },
  {
    id: "privacy_by_design",
    name_el: "Προστασία δεδομένων εξ σχεδιασμού",
    name_en: "Privacy by design",
    description: "Data protection by design and by default (Art. 25 GDPR).",
  },
  {
    id: "cctv",
    name_el: "Βιντεοεπιτήρηση",
    name_en: "CCTV and video surveillance",
    description: "Video surveillance systems in public and private spaces, including compliance with GDPR.",
  },
  {
    id: "health_data",
    name_el: "Δεδομένα υγείας",
    name_en: "Health data",
    description: "Processing of health data — special categories requiring enhanced safeguards (Art. 9 GDPR).",
  },
  {
    id: "children",
    name_el: "Δεδομένα ανηλίκων",
    name_en: "Children's data",
    description: "Protection of children's personal data, especially in online services (Art. 8 GDPR).",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_el, name_en, description) VALUES (?, ?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_el, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  // HDPA Decision on Clearview AI — EUR 20 million
  {
    reference: "HDPA-2022-001",
    title: "HDPA Decision — Clearview AI Inc.",
    date: "2022-07-13",
    type: "sanction",
    entity_name: "Clearview AI Inc.",
    fine_amount: 20_000_000,
    summary:
      "The HDPA imposed a fine of EUR 20 million on Clearview AI for unlawfully processing biometric data of Greek residents by scraping facial images from the internet without a valid legal basis, and for failing to respond to data subject requests. The HDPA ordered Clearview to stop collecting and processing data of Greek residents and to delete data already collected.",
    full_text:
      "The Hellenic Data Protection Authority (HDPA) issued its decision against Clearview AI Inc., a US company that collects billions of facial photographs from publicly available online sources to build a biometric database used for facial recognition services. The HDPA found multiple GDPR violations: (1) Absence of legal basis — Clearview processed biometric data (a special category under Art. 9 GDPR) of Greek residents without consent or any other applicable legal basis under Art. 9(2) GDPR; (2) Violation of data subject rights — Clearview failed to respond adequately to access, erasure, and objection requests from Greek data subjects; (3) Lack of transparency — Clearview did not provide adequate information to data subjects about the processing of their data. The HDPA imposed a fine of EUR 20,000,000 and ordered Clearview to cease collecting and processing data of Greek residents and to erase all data already collected within two months. This decision was coordinated with other EU supervisory authorities including the Italian Garante and the French CNIL.",
    topics: JSON.stringify(["transfers", "consent", "health_data"]),
    gdpr_articles: JSON.stringify(["6", "9", "12", "15", "17", "21"]),
    status: "final",
  },
  // HDPA Decision on Kalamata Municipality — CCTV
  {
    reference: "HDPA-2020-035",
    title: "HDPA Decision — Municipality of Kalamata (CCTV)",
    date: "2020-10-28",
    type: "sanction",
    entity_name: "Municipality of Kalamata",
    fine_amount: 30_000,
    summary:
      "The HDPA fined the Municipality of Kalamata EUR 30,000 for operating a CCTV surveillance system in a public square without a DPIA, without adequate information notices, and without a valid legal basis for the processing.",
    full_text:
      "The HDPA investigated the CCTV surveillance system operated by the Municipality of Kalamata in Aristomenous Square and surrounding streets. The investigation revealed: (1) No Data Protection Impact Assessment (DPIA) had been conducted prior to deployment of the surveillance system, despite the obligation under Art. 35 GDPR for systematic monitoring of publicly accessible areas; (2) Information notices were absent or inadequate — the municipality had not placed visible signs informing individuals that they were under video surveillance, as required by Art. 13 GDPR; (3) Retention periods — recordings were retained for 15 days without documented justification for this period; (4) The municipality could not demonstrate a valid legal basis under Art. 6 GDPR for the surveillance. The HDPA imposed a fine of EUR 30,000 and ordered the municipality to conduct a DPIA, install proper information notices, and document the legal basis for the processing.",
    topics: JSON.stringify(["cctv", "dpia", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["5", "6", "13", "25", "35"]),
    status: "final",
  },
  // HDPA Decision on Wind Hellas — telemarketing
  {
    reference: "HDPA-2021-047",
    title: "HDPA Decision — Wind Hellas Telecommunications S.A.",
    date: "2021-08-19",
    type: "sanction",
    entity_name: "Wind Hellas Telecommunications S.A.",
    fine_amount: 200_000,
    summary:
      "The HDPA fined Wind Hellas EUR 200,000 for processing personal data for telemarketing purposes without valid consent, and for retaining customer data beyond permissible periods.",
    full_text:
      "The HDPA investigated Wind Hellas Telecommunications S.A. following multiple complaints from individuals who received unsolicited marketing calls despite having registered with the national opt-out registry (Αρχείο Εξαίρεσης). Findings: (1) Wind Hellas contacted individuals who had registered their opt-out preference in the national registry maintained under Law 3471/2006, in violation of Art. 6(1)(a) GDPR and the applicable national provisions; (2) The consent forms used by Wind Hellas were bundled with service acceptance terms and did not meet the GDPR requirement for freely given, specific, informed and unambiguous consent; (3) Data retention — customer data was retained after the termination of contractual relationships for periods exceeding those necessary and without adequate documentation of the legal basis. The HDPA imposed a fine of EUR 200,000 and ordered Wind Hellas to review its consent mechanisms and data retention policies.",
    topics: JSON.stringify(["consent"]),
    gdpr_articles: JSON.stringify(["5", "6", "7", "17"]),
    status: "final",
  },
  // HDPA Decision on Ote Group — employee monitoring
  {
    reference: "HDPA-2022-018",
    title: "HDPA Decision — OTE Group (Employee Email Monitoring)",
    date: "2022-03-10",
    type: "sanction",
    entity_name: "OTE S.A.",
    fine_amount: 150_000,
    summary:
      "The HDPA fined OTE S.A. EUR 150,000 for monitoring employee email communications without informing employees in advance, and for processing employee personal data without an adequate legal basis.",
    full_text:
      "The HDPA investigated OTE S.A. (Hellenic Telecommunications Organisation) following an employee complaint about monitoring of work email accounts. The HDPA found: (1) OTE had accessed and reviewed employee email accounts in the context of an internal investigation without prior notification to the employees concerned, in violation of Art. 5(1)(a) (transparency) and Art. 13 GDPR; (2) The processing could not be justified under Art. 6(1)(f) (legitimate interests) without a balancing test demonstrating that OTE's interests overrode employees' privacy rights; (3) OTE had not conducted a DPIA for the email monitoring system despite it constituting systematic monitoring of employees. The HDPA imposed a fine of EUR 150,000 and ordered OTE to update its employee privacy notices and implement a documented balancing test before any future email monitoring.",
    topics: JSON.stringify(["dpia", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["5", "6", "13", "35"]),
    status: "final",
  },
  // HDPA Decision on Alpha Bank — data breach
  {
    reference: "HDPA-2021-009",
    title: "HDPA Decision — Alpha Bank S.A. (Data Breach)",
    date: "2021-02-25",
    type: "sanction",
    entity_name: "Alpha Bank S.A.",
    fine_amount: 65_000,
    summary:
      "The HDPA fined Alpha Bank EUR 65,000 for failing to notify the HDPA of a personal data breach within the 72-hour deadline and for inadequate security measures that led to the breach.",
    full_text:
      "The HDPA investigated Alpha Bank S.A. following a personal data breach involving customer data. The investigation revealed: (1) Late breach notification — Alpha Bank notified the HDPA 11 days after becoming aware of the breach, significantly exceeding the 72-hour mandatory notification period under Art. 33 GDPR; (2) Incomplete notification — the initial notification was incomplete and did not include all information required by Art. 33(3) GDPR; (3) Security deficiencies — the breach resulted from insufficient access controls and inadequate security monitoring that should have detected the incident earlier. The HDPA imposed a fine of EUR 65,000 and ordered Alpha Bank to improve its breach detection and notification procedures.",
    topics: JSON.stringify(["breach_notification", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  // HDPA Decision on electoral roll data
  {
    reference: "HDPA-2019-028",
    title: "HDPA Decision — Political Party Data Processing",
    date: "2019-11-07",
    type: "decision",
    entity_name: "Political Party (anonymised)",
    fine_amount: 15_000,
    summary:
      "The HDPA fined a political party EUR 15,000 for using electoral roll data for targeted political communication without a valid legal basis and without informing data subjects.",
    full_text:
      "The HDPA investigated a political party that obtained electoral roll data and used it to send personalised political communications by post and phone. Findings: (1) The processing of electoral roll data for personalised political messaging required a legal basis under Art. 6 GDPR; the party relied on legitimate interests under Art. 6(1)(f) but could not demonstrate that data subjects' rights did not override those interests; (2) The party processed political opinion data (a special category under Art. 9) indirectly by targeting individuals based on their electoral registration, without meeting any of the Art. 9(2) conditions; (3) Data subjects were not informed about the processing, in violation of Art. 14 GDPR. The HDPA imposed a fine of EUR 15,000 and ordered the party to cease the processing and delete the data.",
    topics: JSON.stringify(["consent", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["6", "9", "14"]),
    status: "final",
  },
  // HDPA Decision on hospital — health data
  {
    reference: "HDPA-2023-005",
    title: "HDPA Decision — Private Hospital (Patient Data Disclosure)",
    date: "2023-04-18",
    type: "sanction",
    entity_name: "Private Hospital (anonymised)",
    fine_amount: 40_000,
    summary:
      "The HDPA fined a private hospital EUR 40,000 for disclosing patient health data to insurers without patient consent, and for failing to maintain adequate access controls to medical records.",
    full_text:
      "The HDPA investigated a private hospital following a complaint from a patient whose health data had been shared with their health insurer without explicit consent. Findings: (1) The hospital shared detailed medical records with the insurer citing contractual necessity under Art. 6(1)(b) GDPR, but the processing of health data required a specific legal basis under Art. 9(2) GDPR, which was not met; (2) Access controls to the patient management system were inadequate — multiple staff had access to patient records beyond what was necessary for their role, violating the principle of data minimisation under Art. 5(1)(c); (3) The hospital had not documented the legal basis for sharing health data with insurance companies in its records of processing activities. The HDPA imposed a fine of EUR 40,000 and ordered the hospital to implement role-based access controls and document all legal bases for health data disclosures.",
    topics: JSON.stringify(["health_data", "consent", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["5", "6", "9", "25", "30"]),
    status: "final",
  },
  // HDPA Decision on hotel chain — retention
  {
    reference: "HDPA-2022-044",
    title: "HDPA Decision — Hotel Chain (Excessive Data Retention)",
    date: "2022-11-22",
    type: "sanction",
    entity_name: "Hotel Chain (anonymised)",
    fine_amount: 25_000,
    summary:
      "The HDPA fined a hotel chain EUR 25,000 for retaining guest personal data for periods far exceeding what is necessary, and for using guest data for marketing without obtaining valid consent.",
    full_text:
      "The HDPA investigated a hotel chain following a complaint from a former guest who discovered that their personal data, including copies of identity documents, had been retained for over 10 years. Findings: (1) Excessive retention — the hotel retained copies of guest identity documents (passport/ID scans), contact details, and stay records for 10+ years; Greek law requires retention of such records for tax purposes for 5 years, but the hotel retained data beyond this period without justification; (2) Marketing without valid consent — guests were subscribed to marketing communications by default without freely given, specific consent; the consent checkbox was pre-ticked at the time of reservation; (3) The hotel could not produce a retention schedule or privacy notice that justified the retention periods applied. The HDPA imposed a fine of EUR 25,000 and ordered the hotel to implement a documented retention schedule and to obtain fresh consent for marketing.",
    topics: JSON.stringify(["consent", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["5", "6", "7", "13"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "HDPA-GUIDE-DPIA-2022",
    title: "Guidelines on Data Protection Impact Assessment (DPIA)",
    date: "2022-05-25",
    type: "guideline",
    summary:
      "HDPA guidelines on when and how to conduct a Data Protection Impact Assessment under Art. 35 GDPR. Includes the HDPA's list of processing types requiring mandatory DPIA, methodology for the three-step process, and documentation requirements.",
    full_text:
      "The Hellenic Data Protection Authority has published guidelines on conducting Data Protection Impact Assessments (DPIAs) pursuant to Art. 35 GDPR. A DPIA is mandatory when processing is likely to result in a high risk to the rights and freedoms of natural persons. The HDPA's mandatory DPIA list includes: systematic and extensive evaluation of personal aspects via automated processing including profiling; large-scale processing of special categories of data; systematic monitoring of publicly accessible areas. The three-step DPIA methodology: (1) Description of the processing — purposes, data categories, recipients, retention periods, and security measures; (2) Necessity and proportionality assessment — lawfulness, data minimisation, accuracy, and rights of data subjects; (3) Risk management — identification of risks to data subjects (unauthorised access, unintended modification, disappearance), severity and likelihood assessment, and identification of additional safeguards. The HDPA emphasises that DPIAs must be reviewed when there is a change in the processing that may affect the risk assessment. Controllers must consult the HDPA prior to processing where the DPIA indicates residual high risk that cannot be mitigated.",
    topics: JSON.stringify(["dpia", "privacy_by_design"]),
    language: "el",
  },
  {
    reference: "HDPA-GUIDE-COOKIES-2021",
    title: "Guidelines on Cookies and Other Tracking Technologies",
    date: "2021-11-10",
    type: "guideline",
    summary:
      "HDPA guidelines on the use of cookies and tracking technologies on websites and mobile applications. Covers consent requirements, exemptions for strictly necessary cookies, and design requirements for cookie banners.",
    full_text:
      "The HDPA guidelines on cookies address the requirements of Art. 5(3) of Directive 2002/58/EC (ePrivacy Directive) as implemented in Greece by Art. 11 of Law 3471/2006, read in conjunction with GDPR consent requirements. Key requirements: (1) Prior consent — non-essential cookies may only be placed after obtaining valid consent from the user; consent must be specific per purpose (analytics, advertising, social media), freely given, informed, and indicated by an unambiguous affirmative action; (2) No pre-ticked boxes — cookie consent banners must not use pre-ticked checkboxes or default-on settings for non-essential cookies; (3) Equally prominent refusal — refusing cookies must be as easy as accepting them; a refuse button must be present at the same level as the accept button; (4) No cookie walls — access to a service may not be conditioned on acceptance of non-essential cookies, unless equivalent access is provided without tracking; (5) Strictly necessary cookies — cookies essential for service delivery (session cookies, shopping cart cookies, security cookies) do not require consent; (6) Duration — consent must be renewed at least every 12 months; (7) Records — controllers must maintain records of consent.",
    topics: JSON.stringify(["cookies", "consent"]),
    language: "el",
  },
  {
    reference: "HDPA-GUIDE-CCTV-2020",
    title: "Guidelines on Video Surveillance (CCTV) Systems",
    date: "2020-06-15",
    type: "guideline",
    summary:
      "HDPA guidelines on the lawful operation of video surveillance systems in Greece. Covers legal basis, information obligations, retention limits, and special rules for workplaces, public spaces, and commercial premises.",
    full_text:
      "The HDPA guidelines on video surveillance systems address the requirements of GDPR and Law 4624/2019 (the Greek GDPR implementation law). Legal basis for CCTV: public authorities may rely on Art. 6(1)(e) (public task); private entities must rely on Art. 6(1)(f) (legitimate interests) and must conduct a balancing test demonstrating that the purpose (security, protection of property) is necessary and proportionate. Workplace surveillance: CCTV in the workplace requires specific justification; covert surveillance of employees is prohibited except in exceptional circumstances with prior HDPA authorisation; employees must be informed before surveillance begins. Information obligations: visible warning signs must be placed at the entrance to surveilled areas stating the controller's identity, purpose, and contact details; a layered approach is recommended with a sign providing basic information and a reference to the full privacy notice. Retention: recordings must be deleted after a maximum of 15 days unless a specific incident has been detected justifying extended retention. Special locations: CCTV in changing rooms, toilets, or other private spaces is prohibited. Public spaces: surveillance of public spaces by private entities requires a legitimate interest assessment and prior consultation with the HDPA.",
    topics: JSON.stringify(["cctv", "dpia", "privacy_by_design"]),
    language: "el",
  },
  {
    reference: "HDPA-GUIDE-EMPLOYEE-2021",
    title: "Guidelines on Employee Data Protection in the Workplace",
    date: "2021-09-20",
    type: "guideline",
    summary:
      "HDPA guidelines on processing employee personal data. Covers recruitment, employment relationship, monitoring of communications, location tracking, and termination of employment.",
    full_text:
      "The HDPA guidelines on employee data protection address the specific challenges of the employment relationship under GDPR. Legal basis: employee data processing may be based on Art. 6(1)(b) (contract performance), Art. 6(1)(c) (legal obligation), or Art. 6(1)(f) (legitimate interests); consent is generally not a valid basis due to the power imbalance between employer and employee. Recruitment: data collected during recruitment must be limited to what is necessary; unsuccessful applicants' data must be deleted within a reasonable period unless specific consent has been obtained for future vacancies. Monitoring of communications: employers may monitor work communications (email, internet usage) only when (a) employees have been clearly informed in advance, (b) monitoring is proportionate to the purpose, and (c) less intrusive means are not available; keystroke logging and continuous screen capture are generally disproportionate. Location tracking: tracking employees' location via company vehicles or mobile phones is permitted for legitimate purposes (fleet management, safety) but continuous tracking outside working hours is prohibited. Health data: processing employee health data is restricted to what is strictly necessary for occupational health obligations.",
    topics: JSON.stringify(["consent", "privacy_by_design", "cctv"]),
    language: "el",
  },
  {
    reference: "HDPA-GUIDE-BREACH-2022",
    title: "Guidelines on Personal Data Breach Management and Notification",
    date: "2022-08-30",
    type: "guideline",
    summary:
      "HDPA guidelines on identifying, managing, and notifying personal data breaches. Covers the 72-hour notification obligation, notification to data subjects, and documentation of breaches in the internal register.",
    full_text:
      "The HDPA guidelines on data breach management address obligations under Art. 33–34 GDPR. What constitutes a breach: a personal data breach is any security incident leading to accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data. Examples include ransomware attacks, unauthorised access by staff, accidental disclosure, and loss of unencrypted devices. Notification to the HDPA (Art. 33): controllers must notify the HDPA without undue delay and, where feasible, within 72 hours of becoming aware of a breach that is likely to result in risk to data subjects; the notification must include the nature of the breach, categories and approximate number of individuals affected, likely consequences, and measures taken; a phased notification is permitted if all information is not available within 72 hours. Notification to data subjects (Art. 34): when the breach is likely to result in high risk, controllers must notify affected individuals directly without undue delay; notification is not required if data was encrypted or if it would involve disproportionate effort. Documentation: all breaches, including those not requiring notification, must be documented in an internal breach register.",
    topics: JSON.stringify(["breach_notification"]),
    language: "el",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

const decisionCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
).cnt;
const guidelineCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
).cnt;
const topicCount = (
  db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
).cnt;
const decisionFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
).cnt;
const guidelineFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
