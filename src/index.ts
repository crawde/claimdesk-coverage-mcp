#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────

type LineOfBusiness = "auto" | "property" | "general_liability" | "workers_comp" | "health" | "professional_liability" | "product_liability" | "marine" | "cyber" | "umbrella" | "epli" | "directors_officers";
type CoverageResult = "covered" | "excluded" | "conditional" | "sublimited" | "disputed" | "not_applicable";
type PolicyType = "occurrence" | "claims_made" | "claims_made_reported";
type OtherInsuranceMethod = "pro_rata" | "excess" | "primary" | "contribution_by_equal_shares" | "contribution_by_limits";

interface CoverageVerification {
  result: CoverageResult;
  applicableInsuring: string[];
  exclusionsTriggered: string[];
  conditionsMet: boolean;
  conditionsRequired: string[];
  endorsementsApplicable: string[];
  effectiveLimits: { perOccurrence: number; aggregate: number; sublimit?: number };
  deductible: number;
  coverageNotes: string[];
  confidenceScore: number;
}

interface ExclusionAnalysis {
  exclusion: string;
  isoFormRef: string;
  description: string;
  applicability: "applies" | "does_not_apply" | "arguable";
  exceptions: string[];
  buybackAvailable: boolean;
  notes: string;
}

interface LimitsAnalysis {
  policyLimit: number;
  aggregateLimit: number;
  priorPaid: number;
  priorReserved: number;
  aggregateRemaining: number;
  perOccurrenceAvailable: number;
  deductible: number;
  selfInsuredRetention: number;
  sirSatisfied: boolean;
  sublimits: Array<{ coverage: string; limit: number; remaining: number }>;
  erosionPercentage: number;
  exhaustionRisk: "none" | "low" | "moderate" | "high" | "exhausted";
}

interface CoverageGap {
  exposure: string;
  riskLevel: "critical" | "high" | "medium" | "low";
  currentCoverage: string | null;
  recommendedCoverage: string;
  estimatedPremium: string;
  explanation: string;
}

interface PolicyCoordination {
  policyId: string;
  carrier: string;
  role: "primary" | "excess" | "umbrella" | "contributing";
  otherInsuranceClause: OtherInsuranceMethod;
  attachmentPoint: number;
  availableLimit: number;
  contributionAmount: number;
  notes: string;
}

interface AdditionalInsuredStatus {
  status: "covered" | "not_covered" | "limited" | "conditional";
  endorsementType: string;
  endorsementForm: string;
  scopeOfCoverage: string[];
  limitations: string[];
  effectiveDate: string;
  expirationDate: string;
  completedOpsIncluded: boolean;
  primaryNoncontributory: boolean;
  waiverOfSubrogation: boolean;
}

// ── ISO Form Reference Database ──────────────────────────────────────

const ISO_FORMS: Record<string, { name: string; edition: string; description: string }> = {
  "CG 00 01": { name: "Commercial General Liability — Occurrence Form", edition: "04/13", description: "Standard CGL occurrence-basis policy" },
  "CG 00 02": { name: "Commercial General Liability — Claims-Made Form", edition: "04/13", description: "Standard CGL claims-made policy" },
  "CG 20 10": { name: "Additional Insured — Owners, Lessees or Contractors", edition: "04/13", description: "Scheduled person or organization — ongoing operations" },
  "CG 20 37": { name: "Additional Insured — Owners, Lessees or Contractors — Completed Operations", edition: "04/13", description: "AI coverage for completed operations" },
  "CG 20 11": { name: "Additional Insured — Managers or Lessors of Premises", edition: "04/13", description: "AI for premises managers/lessors" },
  "CG 20 26": { name: "Additional Insured — Designated Person or Organization", edition: "04/13", description: "Broadest AI endorsement — blanket or scheduled" },
  "CG 20 33": { name: "Additional Insured — Owners, Lessees or Contractors — Automatic Status When Required in Construction Agreement", edition: "04/13", description: "Automatic AI based on contract requirement" },
  "CG 24 04": { name: "Waiver of Transfer of Rights of Recovery Against Others to Us", edition: "04/13", description: "Waiver of subrogation endorsement" },
  "CP 00 10": { name: "Building and Personal Property Coverage Form", edition: "06/07", description: "Standard commercial property form" },
  "CP 00 30": { name: "Business Income and Extra Expense Coverage Form", edition: "06/07", description: "Business interruption coverage" },
  "CP 10 30": { name: "Causes of Loss — Special Form", edition: "06/07", description: "Broadest property perils — all-risk with exclusions" },
  "CA 00 01": { name: "Business Auto Coverage Form", edition: "10/13", description: "Standard commercial auto policy" },
  "WC 00 00": { name: "Workers Compensation and Employers Liability Insurance Policy", edition: "04/92", description: "Standard workers comp policy" },
  "IM 00 01": { name: "Inland Marine — Accounts Receivable", edition: "06/07", description: "AR floater" },
  "CY 00 01": { name: "Cyber Liability — First and Third Party", edition: "01/21", description: "Standard cyber liability form" },
};

// ── Standard CGL Exclusions (CG 00 01) ──────────────────────────────

const CGL_EXCLUSIONS: Array<{
  letter: string;
  name: string;
  description: string;
  exceptions: string[];
  buybackEndorsement: string | null;
  commonlyArgued: boolean;
}> = [
  { letter: "a", name: "Expected or Intended Injury", description: "Injury or damage expected or intended from the standpoint of the insured", exceptions: ["Bodily injury from use of reasonable force to protect persons or property"], buybackEndorsement: null, commonlyArgued: true },
  { letter: "b", name: "Contractual Liability", description: "Liability assumed under contract or agreement", exceptions: ["Insured contracts — leases, sidetrack agreements, easements, indemnification in contracts for the insured's own negligence"], buybackEndorsement: null, commonlyArgued: true },
  { letter: "c", name: "Liquor Liability", description: "Liability arising from selling, furnishing, or serving alcoholic beverages", exceptions: ["Does not apply if you are not in the business of manufacturing/distributing/selling/serving alcohol"], buybackEndorsement: "CG 21 49", commonlyArgued: false },
  { letter: "d", name: "Workers' Compensation and Similar Laws", description: "Obligations under WC, disability benefits, or unemployment laws", exceptions: [], buybackEndorsement: null, commonlyArgued: false },
  { letter: "e", name: "Employer's Liability", description: "Bodily injury to an employee arising out of and in the course of employment", exceptions: ["Liability assumed under an insured contract", "BI to domestic employees not entitled to WC benefits"], buybackEndorsement: "CG 04 35", commonlyArgued: true },
  { letter: "f", name: "Pollution", description: "Bodily injury or property damage arising out of actual, alleged, or threatened discharge/dispersal/release of pollutants", exceptions: ["BI or PD arising from heat, smoke, or fumes from hostile fire", "On or from premises currently owned/rented with sudden/accidental exception"], buybackEndorsement: "CG 04 22", commonlyArgued: true },
  { letter: "g", name: "Aircraft, Auto, or Watercraft", description: "BI or PD arising out of ownership/use of aircraft, auto, or watercraft", exceptions: ["Watercraft under 26 feet that you do not own", "Parking on or next to premises", "Non-owned watercraft"], buybackEndorsement: null, commonlyArgued: false },
  { letter: "h", name: "Mobile Equipment", description: "Transportation of mobile equipment by auto owned/operated by insured", exceptions: [], buybackEndorsement: null, commonlyArgued: false },
  { letter: "i", name: "War", description: "BI or PD arising from war, civil war, insurrection, rebellion, or revolution", exceptions: [], buybackEndorsement: null, commonlyArgued: false },
  { letter: "j", name: "Damage to Property", description: "PD to property you own/rent/occupy, personal property in the insured's care/custody/control, that particular part of real property on which you are performing operations, that particular part of property that must be restored because your work was incorrectly performed", exceptions: ["Premises rented to you (exception to owned/rented exclusion)"], buybackEndorsement: "CG 22 33", commonlyArgued: true },
  { letter: "k", name: "Damage to Your Product", description: "PD to your product arising from defect or deficiency", exceptions: [], buybackEndorsement: null, commonlyArgued: false },
  { letter: "l", name: "Damage to Your Work", description: "PD to your work arising from defect or deficiency and included in the products-completed operations hazard", exceptions: ["Work performed by subcontractors on your behalf"], buybackEndorsement: null, commonlyArgued: true },
  { letter: "m", name: "Damage to Impaired Property", description: "PD to impaired property arising from defect/deficiency/dangerous condition in your product or work; or delay/failure to perform a contract", exceptions: ["Loss of use of other property caused by sudden physical injury to your product or work after it has been put to its intended use"], buybackEndorsement: null, commonlyArgued: true },
  { letter: "n", name: "Recall of Products, Work, or Impaired Property", description: "Damages claimed for loss/cost/expense of recall, withdrawal, inspection, repair, replacement, or disposal", exceptions: [], buybackEndorsement: "CG 04 41", commonlyArgued: false },
  { letter: "p", name: "Personal and Advertising Injury", description: "Various offenses including false arrest, malicious prosecution, wrongful eviction, slander, libel, use of advertising idea, copyright infringement", exceptions: ["Does not apply to Coverage B — this exclusion modifies Coverage A only"], buybackEndorsement: null, commonlyArgued: false },
];

// ── Property Exclusions (CP 10 30 Special Form) ────────────────────

const PROPERTY_EXCLUSIONS: Array<{
  name: string;
  description: string;
  exceptions: string[];
  buybackEndorsement: string | null;
}> = [
  { name: "Ordinance or Law", description: "Loss from enforcement of building, zoning, or land-use ordinances", exceptions: [], buybackEndorsement: "CP 04 05" },
  { name: "Earth Movement", description: "Earthquake, landslide, mudslide, sinkhole, volcanic activity, subsidence", exceptions: ["Fire or explosion resulting from earth movement", "Volcanic action (limited)"], buybackEndorsement: "CP 10 40" },
  { name: "Governmental Action", description: "Seizure or destruction by government authority", exceptions: ["Destruction to prevent spread of fire"], buybackEndorsement: null },
  { name: "Nuclear Hazard", description: "Nuclear reaction, radiation, or radioactive contamination", exceptions: ["Ensuing fire"], buybackEndorsement: null },
  { name: "Power Failure", description: "Utility power failure off premises", exceptions: ["Resulting covered peril on premises"], buybackEndorsement: "CP 04 17" },
  { name: "War and Military Action", description: "War, military action, insurrection", exceptions: [], buybackEndorsement: null },
  { name: "Water (Flood)", description: "Flood, surface water, tidal waves, overflow of body of water, mudslide", exceptions: [], buybackEndorsement: "Separate flood policy (NFIP)" },
  { name: "Fungus/Wet Rot/Dry Rot", description: "Presence, growth, proliferation, or spread of fungus, wet rot, or dry rot", exceptions: ["$15,000 limited exception when caused by covered peril"], buybackEndorsement: "CP 04 23" },
  { name: "Virus or Bacteria", description: "Loss from virus or bacteria", exceptions: [], buybackEndorsement: null },
  { name: "Wear and Tear / Deterioration", description: "Gradual wear, tear, deterioration, inherent vice, latent defect", exceptions: ["Resulting covered peril"], buybackEndorsement: null },
  { name: "Settling/Cracking/Expansion", description: "Settling, cracking, shrinking, bulging, or expansion", exceptions: ["Resulting covered peril"], buybackEndorsement: null },
  { name: "Smog / Industrial Smoke", description: "Smog from agricultural or industrial operations", exceptions: [], buybackEndorsement: null },
  { name: "Mechanical Breakdown", description: "Mechanical breakdown including rupture or bursting from centrifugal force", exceptions: ["Resulting covered peril"], buybackEndorsement: "Equipment Breakdown endorsement" },
];

// ── Auto Exclusions ─────────────────────────────────────────────────

const AUTO_EXCLUSIONS: Array<{
  name: string;
  description: string;
  applicableCoverage: string[];
}> = [
  { name: "Expected or Intended Injury", description: "BI or PD expected or intended by the insured", applicableCoverage: ["liability"] },
  { name: "Contractual Liability", description: "Liability assumed under contract", applicableCoverage: ["liability"] },
  { name: "Workers' Compensation", description: "Obligations under WC laws", applicableCoverage: ["liability"] },
  { name: "Employee Indemnification", description: "BI to employee arising from employment", applicableCoverage: ["liability"] },
  { name: "Fellow Employee", description: "BI to a co-employee", applicableCoverage: ["liability"] },
  { name: "Care, Custody, or Control", description: "PD to property in insured's care, custody or control", applicableCoverage: ["liability"] },
  { name: "Handling of Property", description: "PD from loading/unloading before/after making available to others", applicableCoverage: ["liability"] },
  { name: "Movement of Property by Mechanical Device", description: "PD from use of mechanical device unless attached to auto", applicableCoverage: ["liability"] },
  { name: "Racing", description: "Auto used in racing or demolition contest", applicableCoverage: ["physical_damage", "liability"] },
  { name: "War", description: "War, civil war, insurrection", applicableCoverage: ["physical_damage", "liability"] },
  { name: "Nuclear", description: "Nuclear reaction, radiation, or contamination", applicableCoverage: ["physical_damage", "liability"] },
];

// ── Cyber Exclusions ────────────────────────────────────────────────

const CYBER_EXCLUSIONS: Array<{
  name: string;
  description: string;
  buybackAvailable: boolean;
}> = [
  { name: "Infrastructure Failure", description: "Loss from failure of electrical grid, internet backbone, or telecom infrastructure not under the insured's control", buybackAvailable: true },
  { name: "War/Nation-State Attack", description: "Cyber events attributed to acts of war or nation-state sponsored attacks", buybackAvailable: true },
  { name: "Prior Known Events", description: "Events or circumstances known prior to policy inception", buybackAvailable: false },
  { name: "Bodily Injury", description: "Claims for bodily injury or physical damage arising from cyber event", buybackAvailable: false },
  { name: "Patent/Trade Secret", description: "Claims involving patent infringement or misappropriation of trade secrets", buybackAvailable: false },
  { name: "Contractual Liability", description: "Liability assumed under contract beyond what would exist without the contract", buybackAvailable: true },
  { name: "Criminal/Fraudulent Acts", description: "Loss arising from criminal, dishonest, or fraudulent acts of the insured", buybackAvailable: false },
  { name: "Unencrypted Data", description: "Some policies exclude breaches involving unencrypted portable devices or data at rest", buybackAvailable: true },
  { name: "Failure to Maintain Security", description: "Failure to maintain minimum security standards as warranted in the application", buybackAvailable: false },
  { name: "Voluntary Shutdown", description: "Business interruption from voluntary/planned system shutdowns", buybackAvailable: false },
];

// ── Coverage Gap Templates by Industry ──────────────────────────────

const INDUSTRY_RISK_PROFILES: Record<string, Array<{
  exposure: string;
  requiredCoverage: string;
  minimumLimit: number;
  riskLevel: "critical" | "high" | "medium" | "low";
  explanation: string;
}>> = {
  construction: [
    { exposure: "Third-party bodily injury at jobsite", requiredCoverage: "CGL — Occurrence", minimumLimit: 2_000_000, riskLevel: "critical", explanation: "Active construction sites pose significant BI risk to workers, visitors, and passersby" },
    { exposure: "Completed operations defect claims", requiredCoverage: "CGL — Products/Completed Ops", minimumLimit: 2_000_000, riskLevel: "critical", explanation: "Post-completion defect claims can surface years after project completion" },
    { exposure: "Builder's risk / course of construction", requiredCoverage: "Builder's Risk Policy", minimumLimit: 0, riskLevel: "high", explanation: "Protects building under construction from covered perils; limit = project value" },
    { exposure: "Contractor's equipment theft/damage", requiredCoverage: "Inland Marine — Contractor's Equipment", minimumLimit: 500_000, riskLevel: "medium", explanation: "Heavy equipment and tools on jobsite vulnerable to theft, vandalism, weather" },
    { exposure: "Pollution from construction activities", requiredCoverage: "Contractor's Pollution Liability", minimumLimit: 1_000_000, riskLevel: "high", explanation: "Dust, fuel spills, asbestos disturbance, lead paint — standard CGL excludes pollution" },
    { exposure: "Professional design errors (design-build)", requiredCoverage: "Professional Liability / E&O", minimumLimit: 1_000_000, riskLevel: "high", explanation: "Design-build contractors face professional liability exposure excluded from CGL" },
    { exposure: "Subcontractor default", requiredCoverage: "Subcontractor Default Insurance (SDI)", minimumLimit: 0, riskLevel: "medium", explanation: "SDI covers cost of replacing defaulting subs; alternative to performance bonds" },
    { exposure: "Excess/umbrella liability", requiredCoverage: "Commercial Umbrella", minimumLimit: 5_000_000, riskLevel: "high", explanation: "Underlying limits often inadequate for catastrophic construction losses" },
  ],
  manufacturing: [
    { exposure: "Product defect injury/damage claims", requiredCoverage: "CGL — Products Liability", minimumLimit: 5_000_000, riskLevel: "critical", explanation: "Manufactured products distributed widely create mass tort exposure" },
    { exposure: "Product recall costs", requiredCoverage: "Product Recall Insurance", minimumLimit: 2_000_000, riskLevel: "high", explanation: "Standard CGL excludes recall costs; mandatory for consumer products" },
    { exposure: "Equipment breakdown / boiler explosion", requiredCoverage: "Equipment Breakdown / Boiler & Machinery", minimumLimit: 1_000_000, riskLevel: "high", explanation: "Manufacturing equipment failures cause property damage + business interruption" },
    { exposure: "Supply chain disruption", requiredCoverage: "Contingent Business Interruption", minimumLimit: 1_000_000, riskLevel: "medium", explanation: "Dependent on key suppliers; their losses can halt your production" },
    { exposure: "Environmental contamination", requiredCoverage: "Site Pollution Liability", minimumLimit: 2_000_000, riskLevel: "high", explanation: "Manufacturing operations produce waste, emissions, potential soil/water contamination" },
    { exposure: "Cyber attack on OT/SCADA systems", requiredCoverage: "Cyber Liability with OT Coverage", minimumLimit: 2_000_000, riskLevel: "high", explanation: "Connected manufacturing systems vulnerable to ransomware and operational disruption" },
  ],
  healthcare: [
    { exposure: "Medical malpractice", requiredCoverage: "Professional Liability — Medical Malpractice", minimumLimit: 1_000_000, riskLevel: "critical", explanation: "Per-claim limit; aggregate typically 3x. State minimums vary" },
    { exposure: "Patient data breach (HIPAA)", requiredCoverage: "Cyber Liability with HIPAA Module", minimumLimit: 3_000_000, riskLevel: "critical", explanation: "HIPAA breach penalties up to $1.5M/category + class action exposure + OCR investigation costs" },
    { exposure: "Directors & Officers claims", requiredCoverage: "D&O Liability", minimumLimit: 2_000_000, riskLevel: "high", explanation: "Board members face personal liability for governance failures" },
    { exposure: "Sexual misconduct claims", requiredCoverage: "Abuse & Molestation Coverage", minimumLimit: 1_000_000, riskLevel: "critical", explanation: "Often excluded from standard CGL; requires separate endorsement or policy" },
    { exposure: "Business interruption (pandemic/epidemic)", requiredCoverage: "Business Interruption with Infectious Disease", minimumLimit: 2_000_000, riskLevel: "medium", explanation: "Standard property policies exclude virus/bacteria; specialized BI needed" },
    { exposure: "Employment practices claims", requiredCoverage: "EPLI", minimumLimit: 1_000_000, riskLevel: "high", explanation: "Healthcare industry has high employment litigation rates" },
  ],
  technology: [
    { exposure: "Software errors causing client losses", requiredCoverage: "Technology E&O", minimumLimit: 2_000_000, riskLevel: "critical", explanation: "Software bugs, outages, data loss causing downstream financial harm" },
    { exposure: "Data breach / privacy violation", requiredCoverage: "Cyber Liability — First & Third Party", minimumLimit: 5_000_000, riskLevel: "critical", explanation: "Tech companies handle massive data; breach costs average $4.45M" },
    { exposure: "IP infringement claims", requiredCoverage: "IP Defense & Indemnity", minimumLimit: 2_000_000, riskLevel: "high", explanation: "Patent troll and copyright claims increasing against tech firms" },
    { exposure: "Media liability", requiredCoverage: "Media Liability / Advertising Injury", minimumLimit: 1_000_000, riskLevel: "medium", explanation: "Content platforms face defamation, copyright, privacy claims from user-generated content" },
    { exposure: "Key person risk", requiredCoverage: "Key Person Insurance", minimumLimit: 1_000_000, riskLevel: "medium", explanation: "Loss of critical technical talent can materially impact operations/revenue" },
    { exposure: "Social engineering / funds transfer fraud", requiredCoverage: "Crime / Social Engineering Endorsement", minimumLimit: 500_000, riskLevel: "high", explanation: "BEC and social engineering attacks targeting finance teams" },
  ],
  real_estate: [
    { exposure: "Premises liability (slip & fall)", requiredCoverage: "CGL — Premises/Operations", minimumLimit: 1_000_000, riskLevel: "critical", explanation: "Property owners face constant premises liability exposure" },
    { exposure: "Environmental contamination (mold, asbestos, lead)", requiredCoverage: "Site Pollution Liability", minimumLimit: 2_000_000, riskLevel: "high", explanation: "Older buildings frequently have environmental hazards; CGL pollution exclusion applies" },
    { exposure: "Loss of rental income", requiredCoverage: "Loss of Rents / Business Income", minimumLimit: 0, riskLevel: "high", explanation: "Property damage causing tenant displacement; limit = 12mo rental income" },
    { exposure: "Errors & omissions in property management", requiredCoverage: "Property Managers E&O", minimumLimit: 1_000_000, riskLevel: "medium", explanation: "Failure to maintain property, security lapses, tenant screening errors" },
    { exposure: "Flood damage", requiredCoverage: "NFIP or Private Flood", minimumLimit: 500_000, riskLevel: "high", explanation: "Standard property policies exclude flood; required in SFHA zones" },
    { exposure: "Earthquake damage", requiredCoverage: "Earthquake Policy or Endorsement", minimumLimit: 0, riskLevel: "medium", explanation: "Not covered under standard property; critical in seismic zones" },
  ],
};

// ── Other Insurance Clause Rules ────────────────────────────────────

const OTHER_INSURANCE_RULES: Record<OtherInsuranceMethod, {
  description: string;
  calculationMethod: string;
}> = {
  pro_rata: { description: "Each policy pays in proportion to its limit relative to total available limits", calculationMethod: "Policy limit / sum of all policy limits × loss amount" },
  excess: { description: "This policy pays only after all other applicable insurance is exhausted", calculationMethod: "Loss amount - other insurance payments" },
  primary: { description: "This policy pays first, before any other applicable insurance", calculationMethod: "Full loss up to policy limit, then other policies" },
  contribution_by_equal_shares: { description: "Each policy pays equally until one is exhausted, then remaining policies continue equally", calculationMethod: "Loss / number of policies (each up to its limit)" },
  contribution_by_limits: { description: "Each policy contributes in proportion to its applicable limit", calculationMethod: "Policy limit / total limits × loss" },
};

// ── Server ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "claimdesk-coverage-mcp",
  version: "0.1.0",
});

// ── Tool: verify_coverage ────────────────────────────────────────────

server.tool(
  "verify_coverage",
  "Analyze whether a claim is covered under a given policy. Checks insuring agreements, exclusions, conditions, and endorsements. Returns coverage determination with confidence score.",
  {
    line_of_business: z.enum(["auto", "property", "general_liability", "workers_comp", "health", "professional_liability", "product_liability", "marine", "cyber", "umbrella", "epli", "directors_officers"]).describe("Line of business for the policy"),
    policy_type: z.enum(["occurrence", "claims_made", "claims_made_reported"]).default("occurrence").describe("Policy trigger type"),
    loss_description: z.string().describe("Description of the loss or claim"),
    loss_date: z.string().describe("Date of loss (ISO format or descriptive)"),
    policy_effective: z.string().describe("Policy effective date"),
    policy_expiry: z.string().describe("Policy expiry date"),
    claimed_amount: z.number().describe("Claimed amount in USD"),
    per_occurrence_limit: z.number().describe("Per-occurrence or per-claim limit"),
    aggregate_limit: z.number().describe("General aggregate limit"),
    deductible: z.number().default(0).describe("Policy deductible"),
    endorsements: z.array(z.string()).default([]).describe("List of endorsement form numbers or descriptions"),
    specific_exclusions: z.array(z.string()).default([]).describe("Any known manuscript exclusions added to the policy"),
    prior_claims_paid: z.number().default(0).describe("Total paid on prior claims in this policy period"),
    state: z.string().default("DEFAULT").describe("State jurisdiction"),
  },
  async ({ line_of_business, policy_type, loss_description, loss_date, policy_effective, policy_expiry, claimed_amount, per_occurrence_limit, aggregate_limit, deductible, endorsements, specific_exclusions, prior_claims_paid, state }) => {
    const lossLower = loss_description.toLowerCase();

    // Check policy period
    const lossDateParsed = new Date(loss_date);
    const effectiveParsed = new Date(policy_effective);
    const expiryParsed = new Date(policy_expiry);
    const withinPeriod = lossDateParsed >= effectiveParsed && lossDateParsed <= expiryParsed;

    // For claims-made, also need reporting within period or extended reporting
    const claimsMadeIssue = policy_type !== "occurrence" && !withinPeriod;

    // Check aggregate erosion
    const aggregateRemaining = aggregate_limit - prior_claims_paid;
    const aggregateExhausted = aggregateRemaining <= 0;

    // Identify applicable exclusions
    const exclusionsTriggered: string[] = [];
    const applicableInsuring: string[] = [];
    const conditionsRequired: string[] = [];
    const coverageNotes: string[] = [];
    let confidenceScore = 85;

    // CGL-specific analysis
    if (line_of_business === "general_liability") {
      applicableInsuring.push("Coverage A — Bodily Injury and Property Damage Liability");
      if (lossLower.includes("slander") || lossLower.includes("libel") || lossLower.includes("advertising") || lossLower.includes("defamation")) {
        applicableInsuring.push("Coverage B — Personal and Advertising Injury Liability");
      }
      if (lossLower.includes("medical") && lossLower.includes("payment")) {
        applicableInsuring.push("Coverage C — Medical Payments");
      }

      for (const excl of CGL_EXCLUSIONS) {
        const triggers = checkCglExclusionTrigger(excl.letter, lossLower);
        if (triggers) {
          const hasException = excl.exceptions.some(e => lossLower.includes(e.toLowerCase()));
          const buybackApplied = excl.buybackEndorsement && endorsements.includes(excl.buybackEndorsement);
          if (!hasException && !buybackApplied) {
            exclusionsTriggered.push(`Exclusion ${excl.letter.toUpperCase()} — ${excl.name}: ${excl.description}`);
          } else if (hasException) {
            coverageNotes.push(`Exclusion ${excl.letter.toUpperCase()} triggered but exception applies`);
          } else if (buybackApplied) {
            coverageNotes.push(`Exclusion ${excl.letter.toUpperCase()} bought back via ${excl.buybackEndorsement}`);
          }
        }
      }

      conditionsRequired.push("Notice of occurrence given as soon as practicable");
      conditionsRequired.push("Cooperation with insurer investigation and defense");
      conditionsRequired.push("No voluntary payments without insurer consent");
    }

    // Property-specific analysis
    if (line_of_business === "property") {
      applicableInsuring.push("Building Coverage — Covered Causes of Loss");
      applicableInsuring.push("Business Personal Property Coverage");
      if (lossLower.includes("income") || lossLower.includes("revenue") || lossLower.includes("shutdown")) {
        applicableInsuring.push("Business Income and Extra Expense");
      }

      for (const excl of PROPERTY_EXCLUSIONS) {
        if (checkPropertyExclusionTrigger(excl.name, lossLower)) {
          const buybackApplied = excl.buybackEndorsement && endorsements.includes(excl.buybackEndorsement);
          if (!buybackApplied) {
            exclusionsTriggered.push(`${excl.name}: ${excl.description}`);
          } else {
            coverageNotes.push(`${excl.name} exclusion bought back via ${excl.buybackEndorsement}`);
          }
        }
      }

      conditionsRequired.push("Sworn proof of loss within 60 days");
      conditionsRequired.push("Protect property from further damage");
      conditionsRequired.push("Cooperate with insurer investigation");
    }

    // Auto-specific
    if (line_of_business === "auto") {
      applicableInsuring.push("Liability Coverage — Covered Autos");
      if (lossLower.includes("collision") || lossLower.includes("crash") || lossLower.includes("accident")) {
        applicableInsuring.push("Physical Damage — Collision Coverage");
      }
      if (lossLower.includes("theft") || lossLower.includes("vandal") || lossLower.includes("hail") || lossLower.includes("flood") || lossLower.includes("fire")) {
        applicableInsuring.push("Physical Damage — Comprehensive (Other Than Collision)");
      }

      for (const excl of AUTO_EXCLUSIONS) {
        if (lossLower.includes(excl.name.toLowerCase().replace(/[^a-z]/g, " ").trim())) {
          exclusionsTriggered.push(`${excl.name}: ${excl.description}`);
        }
      }
    }

    // Cyber-specific
    if (line_of_business === "cyber") {
      applicableInsuring.push("First-Party — Data Breach Response Costs");
      applicableInsuring.push("First-Party — Business Interruption");
      applicableInsuring.push("Third-Party — Privacy Liability");
      if (lossLower.includes("ransom")) {
        applicableInsuring.push("First-Party — Cyber Extortion / Ransomware");
      }

      for (const excl of CYBER_EXCLUSIONS) {
        if (lossLower.includes(excl.name.toLowerCase().replace(/[^a-z ]/g, "").trim())) {
          exclusionsTriggered.push(`${excl.name}: ${excl.description}`);
        }
      }
    }

    // Workers comp
    if (line_of_business === "workers_comp") {
      applicableInsuring.push("Part One — Workers Compensation (statutory benefits)");
      applicableInsuring.push("Part Two — Employers Liability");
      conditionsRequired.push("Injury arose out of and in the course of employment");
      conditionsRequired.push("Employer-employee relationship established");
    }

    // Add manuscript exclusions
    for (const me of specific_exclusions) {
      exclusionsTriggered.push(`Manuscript Exclusion: ${me}`);
    }

    // Determine result
    let result: CoverageResult = "covered";

    if (!withinPeriod && policy_type === "occurrence") {
      result = "not_applicable";
      coverageNotes.push("Loss date falls outside the policy period");
      confidenceScore = 95;
    } else if (claimsMadeIssue) {
      result = "not_applicable";
      coverageNotes.push("Claims-made policy: claim not reported within policy period or extended reporting period");
      confidenceScore = 90;
    } else if (aggregateExhausted) {
      result = "not_applicable";
      coverageNotes.push("Aggregate limit exhausted by prior claims");
      confidenceScore = 95;
    } else if (exclusionsTriggered.length > 0) {
      result = exclusionsTriggered.length >= 2 ? "excluded" : "conditional";
      confidenceScore = exclusionsTriggered.length >= 2 ? 80 : 65;
      if (result === "conditional") {
        coverageNotes.push("Single exclusion triggered — coverage determination depends on specific facts and applicable case law");
      }
    }

    // Check sublimit applicability
    let sublimit: number | undefined;
    if (line_of_business === "property" && (lossLower.includes("mold") || lossLower.includes("fungus"))) {
      sublimit = 15_000;
      result = "sublimited";
      coverageNotes.push("Fungus/mold subject to $15,000 sublimit under standard form");
    }

    // Effective limits
    const effectiveLimits = {
      perOccurrence: Math.min(per_occurrence_limit, aggregateRemaining),
      aggregate: aggregateRemaining,
      sublimit,
    };

    const verification: CoverageVerification = {
      result,
      applicableInsuring,
      exclusionsTriggered,
      conditionsMet: conditionsRequired.length > 0 ? false : true,
      conditionsRequired,
      endorsementsApplicable: endorsements.filter(e => Object.keys(ISO_FORMS).includes(e)),
      effectiveLimits,
      deductible,
      coverageNotes,
      confidenceScore,
    };

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(verification, null, 2),
      }],
    };
  }
);

// ── Tool: check_exclusions ──────────────────────────────────────────

server.tool(
  "check_exclusions",
  "Identify all applicable exclusions for a claim scenario. Returns detailed analysis of each standard ISO and manuscript exclusion with applicability assessment, exceptions, and buyback availability.",
  {
    line_of_business: z.enum(["auto", "property", "general_liability", "cyber"]).describe("Line of business to check exclusions for"),
    loss_description: z.string().describe("Description of the loss or claim scenario"),
    endorsements: z.array(z.string()).default([]).describe("Endorsement forms on the policy"),
  },
  async ({ line_of_business, loss_description, endorsements }) => {
    const lossLower = loss_description.toLowerCase();
    const analyses: ExclusionAnalysis[] = [];

    if (line_of_business === "general_liability") {
      for (const excl of CGL_EXCLUSIONS) {
        const triggered = checkCglExclusionTrigger(excl.letter, lossLower);
        const buybackApplied = excl.buybackEndorsement ? endorsements.includes(excl.buybackEndorsement) : false;

        analyses.push({
          exclusion: `Exclusion ${excl.letter.toUpperCase()} — ${excl.name}`,
          isoFormRef: "CG 00 01",
          description: excl.description,
          applicability: triggered ? (excl.commonlyArgued ? "arguable" : "applies") : "does_not_apply",
          exceptions: excl.exceptions,
          buybackAvailable: excl.buybackEndorsement !== null && !buybackApplied,
          notes: buybackApplied
            ? `Buyback endorsement ${excl.buybackEndorsement} is on the policy — exclusion negated`
            : triggered && excl.buybackEndorsement
              ? `Consider adding ${excl.buybackEndorsement} to buy back this exclusion`
              : triggered && excl.commonlyArgued
                ? "This exclusion is commonly litigated — fact-specific determination required"
                : "",
        });
      }
    }

    if (line_of_business === "property") {
      for (const excl of PROPERTY_EXCLUSIONS) {
        const triggered = checkPropertyExclusionTrigger(excl.name, lossLower);
        const buybackApplied = excl.buybackEndorsement ? endorsements.includes(excl.buybackEndorsement) : false;

        analyses.push({
          exclusion: excl.name,
          isoFormRef: "CP 10 30",
          description: excl.description,
          applicability: triggered ? "applies" : "does_not_apply",
          exceptions: excl.exceptions,
          buybackAvailable: excl.buybackEndorsement !== null && !buybackApplied,
          notes: buybackApplied
            ? `Buyback via ${excl.buybackEndorsement} is on policy`
            : triggered && excl.buybackEndorsement
              ? `Recommend: ${excl.buybackEndorsement}`
              : "",
        });
      }
    }

    if (line_of_business === "auto") {
      for (const excl of AUTO_EXCLUSIONS) {
        const triggered = lossLower.includes(excl.name.toLowerCase().split(" ")[0]);
        analyses.push({
          exclusion: excl.name,
          isoFormRef: "CA 00 01",
          description: excl.description,
          applicability: triggered ? "applies" : "does_not_apply",
          exceptions: [],
          buybackAvailable: false,
          notes: triggered ? `Applies to: ${excl.applicableCoverage.join(", ")}` : "",
        });
      }
    }

    if (line_of_business === "cyber") {
      for (const excl of CYBER_EXCLUSIONS) {
        const keywords = excl.name.toLowerCase().split(/[ /]+/);
        const triggered = keywords.some(k => k.length > 3 && lossLower.includes(k));
        analyses.push({
          exclusion: excl.name,
          isoFormRef: "CY 00 01",
          description: excl.description,
          applicability: triggered ? "applies" : "does_not_apply",
          exceptions: [],
          buybackAvailable: excl.buybackAvailable,
          notes: triggered && excl.buybackAvailable ? "Buyback endorsement available from most carriers" : "",
        });
      }
    }

    const triggered = analyses.filter(a => a.applicability !== "does_not_apply");
    const summary = {
      totalExclusionsChecked: analyses.length,
      exclusionsTriggered: triggered.length,
      arguable: analyses.filter(a => a.applicability === "arguable").length,
      buybacksAvailable: triggered.filter(a => a.buybackAvailable).length,
      analyses,
    };

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(summary, null, 2),
      }],
    };
  }
);

// ── Tool: analyze_limits ────────────────────────────────────────────

server.tool(
  "analyze_limits",
  "Calculate available limits after prior claims, aggregate erosion, deductible application, and SIR satisfaction. Shows sublimit analysis and exhaustion risk.",
  {
    per_occurrence_limit: z.number().describe("Per-occurrence or per-claim limit"),
    aggregate_limit: z.number().describe("General aggregate limit"),
    products_ops_aggregate: z.number().default(0).describe("Products/completed operations aggregate (CGL)"),
    prior_claims: z.array(z.object({
      description: z.string(),
      paid: z.number(),
      reserved: z.number(),
    })).default([]).describe("Prior claims in this policy period"),
    deductible: z.number().default(0).describe("Per-occurrence deductible"),
    self_insured_retention: z.number().default(0).describe("Self-insured retention amount"),
    sir_paid_to_date: z.number().default(0).describe("Amount already paid toward SIR satisfaction"),
    current_claim_amount: z.number().describe("Current claim estimated amount"),
    sublimits: z.array(z.object({
      coverage: z.string(),
      limit: z.number(),
      prior_paid: z.number().default(0),
    })).default([]).describe("Any applicable sublimits"),
  },
  async ({ per_occurrence_limit, aggregate_limit, products_ops_aggregate, prior_claims, deductible, self_insured_retention, sir_paid_to_date, current_claim_amount, sublimits }) => {
    const totalPriorPaid = prior_claims.reduce((sum, c) => sum + c.paid, 0);
    const totalPriorReserved = prior_claims.reduce((sum, c) => sum + c.reserved, 0);
    const aggregateRemaining = aggregate_limit - totalPriorPaid;
    const perOccurrenceAvailable = Math.min(per_occurrence_limit, aggregateRemaining);
    const sirSatisfied = self_insured_retention <= 0 || sir_paid_to_date >= self_insured_retention;

    const sublimitAnalysis = sublimits.map(s => ({
      coverage: s.coverage,
      limit: s.limit,
      remaining: s.limit - s.prior_paid,
    }));

    const erosionPercentage = aggregate_limit > 0 ? Math.round(((aggregate_limit - aggregateRemaining) / aggregate_limit) * 100) : 0;

    let exhaustionRisk: "none" | "low" | "moderate" | "high" | "exhausted" = "none";
    const projectedTotal = totalPriorPaid + totalPriorReserved + current_claim_amount;
    if (aggregateRemaining <= 0) exhaustionRisk = "exhausted";
    else if (projectedTotal >= aggregate_limit) exhaustionRisk = "high";
    else if (projectedTotal >= aggregate_limit * 0.75) exhaustionRisk = "moderate";
    else if (projectedTotal >= aggregate_limit * 0.5) exhaustionRisk = "low";

    const analysis: LimitsAnalysis = {
      policyLimit: per_occurrence_limit,
      aggregateLimit: aggregate_limit,
      priorPaid: totalPriorPaid,
      priorReserved: totalPriorReserved,
      aggregateRemaining,
      perOccurrenceAvailable,
      deductible,
      selfInsuredRetention: self_insured_retention,
      sirSatisfied,
      sublimits: sublimitAnalysis,
      erosionPercentage,
      exhaustionRisk,
    };

    const warnings: string[] = [];
    if (exhaustionRisk === "high" || exhaustionRisk === "exhausted") {
      warnings.push("CRITICAL: Aggregate approaching or at exhaustion. Consider excess/umbrella activation.");
    }
    if (!sirSatisfied) {
      warnings.push(`SIR not satisfied: $${(self_insured_retention - sir_paid_to_date).toLocaleString()} remaining before policy responds.`);
    }
    if (current_claim_amount > perOccurrenceAvailable) {
      warnings.push(`Claim amount ($${current_claim_amount.toLocaleString()}) exceeds available per-occurrence limit ($${perOccurrenceAvailable.toLocaleString()}).`);
    }
    if (products_ops_aggregate > 0) {
      warnings.push(`Products/Completed Operations aggregate: $${products_ops_aggregate.toLocaleString()} (separate from general aggregate).`);
    }
    for (const sl of sublimitAnalysis) {
      if (sl.remaining <= 0) {
        warnings.push(`Sublimit exhausted: ${sl.coverage}`);
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ analysis, warnings, priorClaimsDetail: prior_claims }, null, 2),
      }],
    };
  }
);

// ── Tool: find_coverage_gaps ────────────────────────────────────────

server.tool(
  "find_coverage_gaps",
  "Identify uninsured or underinsured exposures by comparing a risk profile against a policy portfolio. Returns prioritized gaps with recommended coverage and estimated premiums.",
  {
    industry: z.enum(["construction", "manufacturing", "healthcare", "technology", "real_estate"]).describe("Industry vertical for risk profile"),
    annual_revenue: z.number().describe("Annual revenue in USD"),
    employee_count: z.number().describe("Number of employees"),
    existing_policies: z.array(z.object({
      type: z.string().describe("Coverage type (e.g., CGL, Property, Auto, WC, Umbrella, Cyber, E&O)"),
      limit: z.number().describe("Per-occurrence or per-claim limit"),
      aggregate: z.number().describe("Aggregate limit"),
      deductible: z.number().default(0),
    })).describe("Current insurance portfolio"),
    specific_exposures: z.array(z.string()).default([]).describe("Any specific known exposures or concerns"),
  },
  async ({ industry, annual_revenue, employee_count, existing_policies, specific_exposures }) => {
    const riskProfile = INDUSTRY_RISK_PROFILES[industry] || [];
    const gaps: CoverageGap[] = [];

    const existingTypes = existing_policies.map(p => p.type.toLowerCase());

    for (const risk of riskProfile) {
      const coverageKeywords = risk.requiredCoverage.toLowerCase().split(/[\s—/]+/);
      const hasCoverage = existingTypes.some(t =>
        coverageKeywords.some(k => k.length > 3 && t.includes(k))
      );

      if (!hasCoverage) {
        // Estimate minimum limit based on revenue
        let recommendedLimit = risk.minimumLimit;
        if (annual_revenue > 10_000_000) recommendedLimit = Math.max(recommendedLimit, risk.minimumLimit * 2);
        if (annual_revenue > 50_000_000) recommendedLimit = Math.max(recommendedLimit, risk.minimumLimit * 3);

        // Rough premium estimate
        const premiumMultiplier = risk.riskLevel === "critical" ? 0.008 : risk.riskLevel === "high" ? 0.005 : 0.003;
        const estimatedPremium = Math.round(recommendedLimit * premiumMultiplier);

        gaps.push({
          exposure: risk.exposure,
          riskLevel: risk.riskLevel,
          currentCoverage: null,
          recommendedCoverage: risk.requiredCoverage,
          estimatedPremium: `$${estimatedPremium.toLocaleString()}-${Math.round(estimatedPremium * 1.5).toLocaleString()}/yr (estimate)`,
          explanation: risk.explanation,
        });
      } else {
        // Check if limit is adequate
        const matchingPolicy = existing_policies.find(p =>
          coverageKeywords.some(k => k.length > 3 && p.type.toLowerCase().includes(k))
        );
        if (matchingPolicy && matchingPolicy.limit < risk.minimumLimit) {
          gaps.push({
            exposure: risk.exposure,
            riskLevel: risk.riskLevel,
            currentCoverage: `${matchingPolicy.type}: $${matchingPolicy.limit.toLocaleString()} limit`,
            recommendedCoverage: `Increase to minimum $${risk.minimumLimit.toLocaleString()}`,
            estimatedPremium: "Contact carrier for endorsement pricing",
            explanation: `Current limit ($${matchingPolicy.limit.toLocaleString()}) is below recommended minimum ($${risk.minimumLimit.toLocaleString()}) for ${industry} operations`,
          });
        }
      }
    }

    // Check umbrella adequacy
    const umbrellaPolicy = existing_policies.find(p => p.type.toLowerCase().includes("umbrella") || p.type.toLowerCase().includes("excess"));
    const totalUnderlyingLimits = existing_policies.filter(p => !p.type.toLowerCase().includes("umbrella")).reduce((sum, p) => sum + p.limit, 0);
    const recommendedUmbrella = Math.max(5_000_000, annual_revenue * 0.5);
    if (!umbrellaPolicy) {
      gaps.push({
        exposure: "Catastrophic loss exceeding primary limits",
        riskLevel: "critical",
        currentCoverage: null,
        recommendedCoverage: `Commercial Umbrella — $${(recommendedUmbrella / 1_000_000).toFixed(0)}M minimum`,
        estimatedPremium: `$${Math.round(recommendedUmbrella * 0.003).toLocaleString()}-${Math.round(recommendedUmbrella * 0.006).toLocaleString()}/yr`,
        explanation: "Umbrella/excess liability is essential for any business. Covers catastrophic claims exceeding primary policy limits.",
      });
    } else if (umbrellaPolicy.limit < recommendedUmbrella) {
      gaps.push({
        exposure: "Inadequate excess liability protection",
        riskLevel: "high",
        currentCoverage: `Umbrella: $${umbrellaPolicy.limit.toLocaleString()}`,
        recommendedCoverage: `Increase umbrella to $${(recommendedUmbrella / 1_000_000).toFixed(0)}M`,
        estimatedPremium: "Contact carrier for additional limits pricing",
        explanation: `Current umbrella ($${umbrellaPolicy.limit.toLocaleString()}) may be inadequate for a $${annual_revenue.toLocaleString()} revenue ${industry} operation`,
      });
    }

    // Add specific exposure gaps
    for (const exposure of specific_exposures) {
      const alreadyFound = gaps.some(g => g.exposure.toLowerCase().includes(exposure.toLowerCase()));
      if (!alreadyFound) {
        gaps.push({
          exposure: exposure,
          riskLevel: "medium",
          currentCoverage: null,
          recommendedCoverage: "Review with broker — specialized coverage may be needed",
          estimatedPremium: "Varies by carrier and exposure details",
          explanation: `Specific exposure identified: ${exposure}. Review current portfolio for applicable coverage.`,
        });
      }
    }

    // Sort by risk level
    const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    gaps.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          industry,
          annualRevenue: annual_revenue,
          employeeCount: employee_count,
          existingPoliciesCount: existing_policies.length,
          gapsFound: gaps.length,
          criticalGaps: gaps.filter(g => g.riskLevel === "critical").length,
          highGaps: gaps.filter(g => g.riskLevel === "high").length,
          gaps,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: coordinate_policies ───────────────────────────────────────

server.tool(
  "coordinate_policies",
  "Determine priority and contribution across multiple applicable policies for a single claim. Analyzes other-insurance clauses, attachment points, and contribution methods.",
  {
    loss_amount: z.number().describe("Total loss amount to be allocated"),
    policies: z.array(z.object({
      policy_id: z.string().describe("Policy identifier"),
      carrier: z.string().describe("Insurance carrier name"),
      limit: z.number().describe("Per-occurrence limit"),
      aggregate_remaining: z.number().describe("Remaining aggregate"),
      deductible: z.number().default(0),
      other_insurance_clause: z.enum(["pro_rata", "excess", "primary", "contribution_by_equal_shares", "contribution_by_limits"]).describe("Other insurance clause type"),
      attachment_point: z.number().default(0).describe("Attachment point for excess/umbrella policies"),
      is_umbrella: z.boolean().default(false).describe("Whether this is an umbrella/excess policy"),
    })).describe("All potentially applicable policies"),
  },
  async ({ loss_amount, policies }) => {
    // Separate primary from excess
    const primaryPolicies = policies.filter(p => !p.is_umbrella && p.attachment_point === 0);
    const excessPolicies = policies.filter(p => p.is_umbrella || p.attachment_point > 0)
      .sort((a, b) => a.attachment_point - b.attachment_point);

    const coordinations: PolicyCoordination[] = [];
    let remaining = loss_amount;

    // Step 1: Determine primary policy payments
    if (primaryPolicies.length === 1) {
      const p = primaryPolicies[0];
      const deductibleApplied = Math.min(p.deductible, remaining);
      remaining -= deductibleApplied;
      const policyPays = Math.min(remaining, p.limit - p.deductible, p.aggregate_remaining);
      coordinations.push({
        policyId: p.policy_id,
        carrier: p.carrier,
        role: "primary",
        otherInsuranceClause: p.other_insurance_clause,
        attachmentPoint: 0,
        availableLimit: Math.min(p.limit, p.aggregate_remaining),
        contributionAmount: policyPays,
        notes: `Primary policy pays $${policyPays.toLocaleString()} after $${deductibleApplied.toLocaleString()} deductible`,
      });
      remaining -= policyPays;
    } else if (primaryPolicies.length > 1) {
      // Multiple primary policies — need to resolve other-insurance conflict
      const hasExcessClause = primaryPolicies.some(p => p.other_insurance_clause === "excess");
      const hasPrimaryClause = primaryPolicies.some(p => p.other_insurance_clause === "primary");

      if (hasPrimaryClause && hasExcessClause) {
        // Primary pays first, excess pays remainder
        const primary = primaryPolicies.filter(p => p.other_insurance_clause === "primary");
        const excess = primaryPolicies.filter(p => p.other_insurance_clause === "excess");

        for (const p of primary) {
          const available = Math.min(p.limit, p.aggregate_remaining);
          const pays = Math.min(remaining, available);
          coordinations.push({
            policyId: p.policy_id,
            carrier: p.carrier,
            role: "primary",
            otherInsuranceClause: p.other_insurance_clause,
            attachmentPoint: 0,
            availableLimit: available,
            contributionAmount: pays,
            notes: "Policy has primary other-insurance clause — pays first",
          });
          remaining -= pays;
        }

        for (const p of excess) {
          const available = Math.min(p.limit, p.aggregate_remaining);
          const pays = Math.min(remaining, available);
          coordinations.push({
            policyId: p.policy_id,
            carrier: p.carrier,
            role: "contributing",
            otherInsuranceClause: p.other_insurance_clause,
            attachmentPoint: 0,
            availableLimit: available,
            contributionAmount: pays,
            notes: "Policy has excess other-insurance clause — pays after primary policies exhausted",
          });
          remaining -= pays;
        }
      } else {
        // Default: contribution by limits (most common resolution)
        const totalLimits = primaryPolicies.reduce((sum, p) => sum + Math.min(p.limit, p.aggregate_remaining), 0);
        for (const p of primaryPolicies) {
          const available = Math.min(p.limit, p.aggregate_remaining);
          const share = totalLimits > 0 ? available / totalLimits : 1 / primaryPolicies.length;
          const pays = Math.min(Math.round(remaining * share), available);
          coordinations.push({
            policyId: p.policy_id,
            carrier: p.carrier,
            role: "contributing",
            otherInsuranceClause: p.other_insurance_clause,
            attachmentPoint: 0,
            availableLimit: available,
            contributionAmount: pays,
            notes: `Contributing ${(share * 100).toFixed(1)}% by limits method ($${available.toLocaleString()} / $${totalLimits.toLocaleString()})`,
          });
          remaining -= pays;
        }
      }
    }

    // Step 2: Excess/umbrella layers
    for (const p of excessPolicies) {
      if (remaining <= 0) break;
      const primaryPaid = loss_amount - remaining;
      if (primaryPaid < p.attachment_point) {
        coordinations.push({
          policyId: p.policy_id,
          carrier: p.carrier,
          role: p.is_umbrella ? "umbrella" : "excess",
          otherInsuranceClause: p.other_insurance_clause,
          attachmentPoint: p.attachment_point,
          availableLimit: Math.min(p.limit, p.aggregate_remaining),
          contributionAmount: 0,
          notes: `Not triggered — attachment point ($${p.attachment_point.toLocaleString()}) not reached. Primary paid: $${primaryPaid.toLocaleString()}`,
        });
      } else {
        const available = Math.min(p.limit, p.aggregate_remaining);
        const pays = Math.min(remaining, available);
        coordinations.push({
          policyId: p.policy_id,
          carrier: p.carrier,
          role: p.is_umbrella ? "umbrella" : "excess",
          otherInsuranceClause: p.other_insurance_clause,
          attachmentPoint: p.attachment_point,
          availableLimit: available,
          contributionAmount: pays,
          notes: `Excess layer triggered. Pays $${pays.toLocaleString()} above $${p.attachment_point.toLocaleString()} attachment.`,
        });
        remaining -= pays;
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          totalLoss: loss_amount,
          totalCovered: loss_amount - remaining,
          uninsured: remaining,
          policiesInvolved: coordinations.length,
          coordination: coordinations,
          otherInsuranceRules: OTHER_INSURANCE_RULES,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: verify_additional_insured ──────────────────────────────────

server.tool(
  "verify_additional_insured",
  "Check additional insured status, endorsement types, and coverage scope. Determines whether an entity qualifies as an additional insured under the policy and what coverage applies.",
  {
    named_insured: z.string().describe("Named insured on the policy"),
    additional_insured_name: z.string().describe("Entity claiming additional insured status"),
    relationship: z.enum(["owner", "lessee", "contractor", "subcontractor", "landlord", "vendor", "franchisor", "mortgagee", "manager", "other"]).describe("Relationship of AI to named insured"),
    endorsement_form: z.string().default("CG 20 10").describe("AI endorsement form number (e.g., CG 20 10, CG 20 26, CG 20 37)"),
    is_blanket: z.boolean().default(false).describe("Whether endorsement is blanket (automatic) vs scheduled"),
    contract_requires_ai: z.boolean().default(false).describe("Whether the contract between parties requires AI status"),
    contract_requires_primary: z.boolean().default(false).describe("Whether contract requires primary/non-contributory"),
    contract_requires_waiver: z.boolean().default(false).describe("Whether contract requires waiver of subrogation"),
    loss_description: z.string().describe("Description of the claim"),
    loss_during_operations: z.boolean().default(true).describe("Whether loss occurred during ongoing operations vs after completion"),
    policy_effective: z.string().describe("Policy effective date"),
    policy_expiry: z.string().describe("Policy expiry date"),
  },
  async ({ named_insured, additional_insured_name, relationship, endorsement_form, is_blanket, contract_requires_ai, contract_requires_primary, contract_requires_waiver, loss_description, loss_during_operations, policy_effective, policy_expiry }) => {
    const formInfo = ISO_FORMS[endorsement_form];
    const lossLower = loss_description.toLowerCase();

    // Determine scope based on endorsement form
    let scopeOfCoverage: string[] = [];
    let limitations: string[] = [];
    let completedOpsIncluded = false;

    switch (endorsement_form) {
      case "CG 20 10":
        scopeOfCoverage = [
          "Bodily injury caused by ongoing operations of the named insured",
          "Property damage caused by ongoing operations of the named insured",
        ];
        limitations = [
          "Coverage limited to liability caused, in whole or in part, by the named insured's acts or omissions",
          "No coverage for the additional insured's own sole negligence",
          "No coverage for completed operations (use CG 20 37 for that)",
          "Post-2004 edition: limited to vicarious liability only",
        ];
        completedOpsIncluded = false;
        break;

      case "CG 20 37":
        scopeOfCoverage = [
          "Bodily injury caused by completed operations of the named insured",
          "Property damage caused by completed operations of the named insured",
        ];
        limitations = [
          "Only applies to completed operations hazard",
          "Coverage limited to work performed by or on behalf of the named insured",
          "Does not cover ongoing operations (use CG 20 10 for that)",
        ];
        completedOpsIncluded = true;
        break;

      case "CG 20 26":
        scopeOfCoverage = [
          "Bodily injury arising out of named insured's operations",
          "Property damage arising out of named insured's operations",
          "Broadest AI endorsement — not limited to specific project or contract",
        ];
        limitations = [
          "Still limited to liability arising from named insured's operations",
          "Check edition date — older editions broader than current",
        ];
        completedOpsIncluded = false;
        break;

      case "CG 20 33":
        scopeOfCoverage = [
          "Automatic AI status when required by construction agreement",
          "Ongoing operations only",
        ];
        limitations = [
          "Must have written contract requiring AI status",
          "Only applies to construction agreements",
          "No completed operations unless CG 20 37 also added",
        ];
        completedOpsIncluded = false;
        break;

      case "CG 20 11":
        scopeOfCoverage = [
          "AI status for managers or lessors of premises",
          "Liability arising from ownership, maintenance, or use of premises",
        ];
        limitations = [
          "Limited to premises liability only",
          "Does not cover operations of the AI",
        ];
        completedOpsIncluded = false;
        break;

      default:
        scopeOfCoverage = ["Non-standard endorsement — review specific language"];
        limitations = ["Manuscript endorsement — scope depends on specific wording"];
    }

    // Determine status
    let status: "covered" | "not_covered" | "limited" | "conditional" = "covered";

    // Check completed ops timing
    if (!loss_during_operations && !completedOpsIncluded) {
      status = "not_covered";
      limitations.push("CRITICAL: Loss occurred after completion of operations but policy has no completed operations AI endorsement (CG 20 37)");
    }

    // Check blanket vs scheduled
    if (!is_blanket && !contract_requires_ai) {
      status = "conditional";
      limitations.push("AI must be specifically scheduled on the endorsement by name — verify with declarations page");
    }

    // Check if contract AI status is honored
    if (contract_requires_ai && !is_blanket) {
      limitations.push("Contract requires AI status — verify the additional insured is listed on the schedule");
    }

    // Primary/non-contributory check
    const hasPnc = contract_requires_primary;
    const pncEndorsementNeeded = contract_requires_primary;

    // Waiver of subrogation
    const hasWaiver = contract_requires_waiver;

    // Sole negligence check
    if (lossLower.includes("sole negligence") || lossLower.includes("sole fault")) {
      status = "not_covered";
      limitations.push("AI coverage does not extend to the additional insured's sole negligence");
    }

    const result: AdditionalInsuredStatus = {
      status,
      endorsementType: is_blanket ? "Blanket (automatic)" : "Scheduled (named)",
      endorsementForm: formInfo ? `${endorsement_form} — ${formInfo.name} (${formInfo.edition})` : endorsement_form,
      scopeOfCoverage,
      limitations,
      effectiveDate: policy_effective,
      expirationDate: policy_expiry,
      completedOpsIncluded,
      primaryNoncontributory: hasPnc,
      waiverOfSubrogation: hasWaiver,
    };

    const recommendations: string[] = [];
    if (!completedOpsIncluded && relationship === "owner") {
      recommendations.push("Add CG 20 37 for completed operations coverage — critical for construction project owners");
    }
    if (pncEndorsementNeeded) {
      recommendations.push("Add CG 20 01 or equivalent primary/non-contributory endorsement to match contract requirements");
    }
    if (hasWaiver) {
      recommendations.push("Verify CG 24 04 (Waiver of Transfer of Rights of Recovery) is on the policy");
    }
    if (endorsement_form === "CG 20 10" && !is_blanket) {
      recommendations.push("Consider switching to CG 20 33 for automatic AI status on construction projects");
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          namedInsured: named_insured,
          additionalInsured: additional_insured_name,
          relationship,
          verification: result,
          recommendations,
          relevantForms: {
            endorsement: formInfo || { name: "Non-standard", description: "Review manuscript language" },
            waiverOfSubrogation: ISO_FORMS["CG 24 04"],
          },
        }, null, 2),
      }],
    };
  }
);

// ── Helper Functions ─────────────────────────────────────────────────

function checkCglExclusionTrigger(letter: string, lossLower: string): boolean {
  const triggers: Record<string, string[]> = {
    a: ["intentional", "expected", "deliberate", "purpose"],
    b: ["contract", "agreement", "indemnif", "hold harmless"],
    c: ["liquor", "alcohol", "bar", "tavern", "serving drinks"],
    d: ["workers comp", "workers' comp", "disability benefit", "unemployment"],
    e: ["employee injury", "worker injury", "employment", "on the job"],
    f: ["pollution", "contamination", "discharge", "hazardous", "toxic", "asbestos", "lead paint", "mold"],
    g: ["aircraft", "airplane", "helicopter", "watercraft", "boat", "yacht"],
    h: ["mobile equipment", "crane transport"],
    i: ["war", "insurrection", "rebellion", "military action"],
    j: ["own property", "care custody control", "faulty workmanship", "your work"],
    k: ["your product", "defective product", "product defect"],
    l: ["your work", "faulty work", "defective work", "workmanship"],
    m: ["impaired property", "loss of use", "deficiency in product"],
    n: ["recall", "withdrawal", "product recall"],
    p: ["slander", "libel", "false arrest", "wrongful eviction", "advertising"],
  };

  const keywords = triggers[letter] || [];
  return keywords.some(k => lossLower.includes(k));
}

function checkPropertyExclusionTrigger(exclusionName: string, lossLower: string): boolean {
  const triggers: Record<string, string[]> = {
    "Ordinance or Law": ["ordinance", "building code", "zoning", "demolition order", "code enforcement"],
    "Earth Movement": ["earthquake", "landslide", "mudslide", "sinkhole", "subsidence", "volcanic", "earth movement"],
    "Governmental Action": ["government seizure", "eminent domain", "confiscation"],
    "Nuclear Hazard": ["nuclear", "radiation", "radioactive"],
    "Power Failure": ["power outage", "utility failure", "blackout", "power failure"],
    "War and Military Action": ["war", "military", "insurrection", "terrorism"],
    "Water (Flood)": ["flood", "surface water", "tidal", "storm surge", "mudflow", "overflow"],
    "Fungus/Wet Rot/Dry Rot": ["mold", "fungus", "rot", "mildew", "spore"],
    "Virus or Bacteria": ["virus", "bacteria", "pandemic", "covid", "infectious disease"],
    "Wear and Tear / Deterioration": ["wear and tear", "deteriorat", "inherent vice", "latent defect", "aging"],
    "Settling/Cracking/Expansion": ["settling", "cracking", "shrinking", "bulging", "foundation"],
    "Smog / Industrial Smoke": ["smog", "industrial smoke", "agricultural"],
    "Mechanical Breakdown": ["mechanical breakdown", "equipment failure", "boiler explosion", "machinery"],
  };

  const keywords = triggers[exclusionName] || [];
  return keywords.some(k => lossLower.includes(k));
}

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
