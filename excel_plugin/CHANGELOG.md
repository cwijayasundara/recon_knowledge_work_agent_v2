# Changelog

## Unreleased

- Sign-in gets its own 180 s bound before the 30 s request bound; concurrent requests share one SSO token request, which a sign-in timeout forgets so a retry asks Office again (13008 gets its own message); the sponsor picker offers Retry when the list fails to load.
- A timed-out gate post is checked against the run before anything is re-enabled ("may have been received" / "Not received — you can retry").
- Gate actions stay disabled after a post until a snapshot read after the post's own decision and idle (a click meanwhile is refused); Apply verdicts count only an idle after their own decision. A long job keeps the hold while the stream is connected ("Still working…" after 30 s of silence); the actions come back with "Status may be out of date — refresh." only when the stream is down or after 10 minutes.
- Onboard waits at most 20 s for Excel ("Excel is busy (finish editing the cell), then try again."); a late sheet removal is skipped. Apply's deferred re-render says "The change was sent; the Review sheet will refresh when Excel is free."
- Contract test: freshness-gated waits, failure diagnostics, output kept in `.contract-last.log` (failing or interrupted runs also in `.contract-fail-*.log`).

## 0.1.0

First release of the Excel add-in.

- Task pane: sponsor picker, workbook upload with size, unsaved-file and integrity checks, live run progress over SSE with reconnect.
- Brief card, questions, column re-binding and highlight of the source sheet, header row, columns and finding rows.
- Findings list (acknowledge, exclude row with reason) and a protected Review sheet with ITEM_ID edit preview.
- Sign-off, artifact download (anchor and system browser routes).
- Auth: dev (`X-Actor`) and Entra SSO bearer; production builds refuse dev auth.
- Production hardening: manifest template and builder, CSP static web app config, bundle check (forbidden strings, source maps, size budget), accessibility and logging tests, placeholder icons.
