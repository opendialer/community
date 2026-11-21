<img src="assets/opendialer-mark.png" alt="OpenDialer" width="64">

# OpenDialer Community

OpenDialer Community is the self-hosted edition of OpenDialer for teams that bring their own carrier accounts. Its intended workflow is to invite agents, load a campaign with phone numbers, call them sequentially, record outcomes and follow up.

## What you can use today

This development repository contains the Hono account routes for email registration, verification, login, logout, current-user lookup, password reset and recovery, plus the PostgreSQL identity migrations and Resend delivery code. The integration test runs these routes against PostgreSQL with a simulated email provider. The organization and invitation tables support the shared email module. The team and dialing routes are still being extracted.

Run `docker compose run --build --rm test` to type-check the package and exercise the account workflow. Run `docker compose down -v` to remove this project's disposable test database. The test uses synthetic accounts and sends no email.

See [edition scope](FEATURES.md) for the intended first dialer release and [Community changes](CHANGELOG.md) for progress. The [Community Internal Use License](LICENSE) permits personal and internal business use. Modification, resale, redistribution and third-party hosting require written permission. The same terms cover the included OpenDialer mark.
