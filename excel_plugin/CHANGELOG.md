# Changelog

## 0.1.0

First release of the Excel add-in.

- Task pane: sponsor picker, workbook upload with size, unsaved-file and integrity checks, live run progress over SSE with reconnect.
- Brief card, questions, column re-binding and highlight of the source sheet, header row, columns and finding rows.
- Findings list (acknowledge, exclude row with reason) and a protected Review sheet with ITEM_ID edit preview.
- Sign-off, artifact download (anchor and system browser routes).
- Auth: dev (`X-Actor`) and Entra SSO bearer; production builds refuse dev auth.
- Production hardening: manifest template and builder, CSP static web app config, bundle check (forbidden strings, source maps, size budget), accessibility and logging tests, placeholder icons.
