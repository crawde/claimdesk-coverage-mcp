# claimdesk-coverage-mcp

MCP server for insurance coverage verification and gap analysis. Analyze policies for applicable coverage, check exclusions against ISO forms, calculate available limits, identify coverage gaps, coordinate multi-policy claims, and verify additional insured status.

## Tools

| Tool | Description |
|------|-------------|
| `verify_coverage` | Full coverage determination — insuring agreements, exclusions, conditions, endorsements |
| `check_exclusions` | Detailed exclusion analysis against ISO CGL/Property/Auto/Cyber forms |
| `analyze_limits` | Calculate available limits after erosion, deductibles, SIR, sublimits |
| `find_coverage_gaps` | Gap analysis by industry — construction, manufacturing, healthcare, technology, real estate |
| `coordinate_policies` | Multi-policy allocation — primary/excess/umbrella, other-insurance clause resolution |
| `verify_additional_insured` | AI endorsement verification — CG 20 10, CG 20 26, CG 20 37, CG 20 33, CG 20 11 |

## Coverage Areas

- **CGL**: All 15 standard exclusions (a-p) with exception analysis and buyback endorsements
- **Property**: Special form (CP 10 30) exclusions including flood, earthquake, mold, virus
- **Auto**: Business auto (CA 00 01) exclusions
- **Cyber**: First/third party coverage analysis with war, infrastructure, prior knowledge exclusions
- **Workers Comp**: Statutory benefits and employers liability

## Industry Gap Analysis

Built-in risk profiles for: Construction, Manufacturing, Healthcare, Technology, Real Estate. Each profile includes required coverages, minimum limits, and premium estimates.

## ISO Form Reference

Full database of common ISO endorsement forms: CG 00 01, CG 00 02, CG 20 10, CG 20 26, CG 20 37, CG 20 33, CG 20 11, CG 24 04, CP 00 10, CP 00 30, CP 10 30, CA 00 01, WC 00 00, and more.

## Install

```bash
npx claimdesk-coverage-mcp
```

## Claude Desktop Config

```json
{
  "mcpServers": {
    "claimdesk-coverage": {
      "command": "npx",
      "args": ["-y", "claimdesk-coverage-mcp"]
    }
  }
}
```

## Examples

### Verify Coverage

```
verify_coverage({
  line_of_business: "general_liability",
  policy_type: "occurrence",
  loss_description: "Customer slipped on wet floor in retail store, fractured hip",
  loss_date: "2026-03-15",
  policy_effective: "2026-01-01",
  policy_expiry: "2027-01-01",
  claimed_amount: 250000,
  per_occurrence_limit: 1000000,
  aggregate_limit: 2000000,
  deductible: 5000,
  state: "CA"
})
```

### Find Coverage Gaps

```
find_coverage_gaps({
  industry: "construction",
  annual_revenue: 15000000,
  employee_count: 85,
  existing_policies: [
    { type: "CGL", limit: 1000000, aggregate: 2000000 },
    { type: "Workers Comp", limit: 1000000, aggregate: 1000000 },
    { type: "Commercial Auto", limit: 1000000, aggregate: 1000000 }
  ]
})
```

### Coordinate Multiple Policies

```
coordinate_policies({
  loss_amount: 3500000,
  policies: [
    { policy_id: "CGL-001", carrier: "Hartford", limit: 1000000, aggregate_remaining: 1500000, other_insurance_clause: "primary" },
    { policy_id: "CGL-002", carrier: "Zurich", limit: 1000000, aggregate_remaining: 2000000, other_insurance_clause: "excess" },
    { policy_id: "UMB-001", carrier: "Chubb", limit: 5000000, aggregate_remaining: 5000000, other_insurance_clause: "excess", attachment_point: 1000000, is_umbrella: true }
  ]
})
```

Full claims management platform: [claimdeskai.com](https://claimdeskai.com)

## License

MIT
