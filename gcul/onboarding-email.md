# GCUL preview onboarding email (DRAFT, not sent)

**From:** mirrorz@mirrorizm.com
**To:** gcul-help@google.com
**Subject:** Universal Ledger preview onboarding: mirrorizm.com (hOUR Chain)

---

Hi Universal Ledger team,

We'd like to join the Google Cloud Universal Ledger preview.

- **Organization ID:** <ORG_ID: from `gcloud organizations list`, a long decimal number>
- **Customer ID:** <CUSTOMER_ID: optional; Admin console > Account > Account settings, starts with "C">
- **Project ID(s):** <PROJECT_ID: e.g. hour-chain-gcul, create it first>
- **Preferred region:** us-east4 (our existing infrastructure is in us-east1/us-east4)

About us: mirrorizm.com builds hOUR Chain and the Witching Hour music platform. We're evaluating Universal Ledger to settle music royalty and creator-payment flows, with Chainlink CRE workflows orchestrating offchain and onchain data around it.

We accept that this is a Pre-GA offering under the Pre-GA Offerings Terms.

Thanks,
Fletcher Vaughn
mirrorizm.com

---

## Before sending
1. Create a dedicated project (don't reuse gen-lang-client-0866304360, which runs the nodes):
   `gcloud projects create hour-chain-gcul --organization=<ORG_ID>`
   (Project IDs must be globally unique; pick another name if it's taken.)
2. Get your Org ID: `gcloud organizations list`
3. Fill in the <...> values above and send from mirrorz@mirrorizm.com.

## After Google confirms the allowlist
- `gcloud services enable universalledger.googleapis.com --project <PROJECT_ID>`
- Grant a role: `roles/universalledger.viewer`, `roles/universalledger.editor`, or `roles/universalledger.admin`
- Regions: us-central1, us-east1, us-east4, us-east5, us-west1, europe-west2, europe-west3
