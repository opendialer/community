# Community edition scope

| Workflow | Intended for the self-hosted dialer release |
|---|---|
| Set up a team | Email registration and recovery, organizations, invitations, owner/admin/member roles, and transactional email through the operator's Resend account. |
| Connect a carrier | Organization-funded carrier numbers and SIP connections, caller ID assignments and supported agent transports. Carrier capabilities vary. |
| Make calls | Manual dialing and sequential power dialing, campaign phone-number queues, agent assignment, live session progress, and do-not-call suppression. |
| Follow up | Outcomes, notes, callbacks, supported transcripts, call history, basic pickup and voicemail rates, and Calendly/Cal.com. |
| Operate locally | Docker Compose, PostgreSQL, ClickHouse for reporting, and an edition-specific OpenAPI contract. |

CRM contact profiles, parallel dialing, enrichment, CRM sync, hosted carrier accounts, managed number subsidies, usage packs, billing, outreach email, SMS inbox, Google/Outlook calendars, advanced voicemail tools, warmup and network-wide pickup signals belong to the commercial product.

The README identifies the source modules currently delivered here. The release milestone is a clean Community checkout that can complete an end-to-end power-dialing campaign with a simulated carrier. A frontend is a separate project.
