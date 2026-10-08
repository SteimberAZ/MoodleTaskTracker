# Feature: Class schedule import (SGA PDF) + class reminders per user

## Objective
Each user uploads the "Horario de clases" PDF printed from the UTM SGA (Sistema de Gestión
Académica). The web parses it, shows a preview to confirm, and stores the classes. The user picks one
lead time (30 min, 1 h or 3 h before, or off). The worker sends a notification before each class with
subject, parallel, teacher, time, place, room code/type and floor.

## Why
The owner had this only for themselves (hardcoded `CLASS_SCHEDULE` in `class_schedule.py`).
Now every invited user can have it.

## Source format (verified on a real SGA PDF, 2 pages)
- Header: Período (e.g. `SEPTIEMBRE 2026 - ENERO 2027 (PREGRADO)`), Facultad, Carrera, Malla,
  Estudiante, Nivel, Código de matrícula, Créditos, Fecha de impresión, Cédula.
- Table columns: ASIGNATURA | NIVEL | PARAL. (e.g. `"A"`) | CREDI. | DOCENTE | DEPARTAMENTO DOCENTE
  (may be `—`) | HORARIO Y AMBIENTE.
- Each schedule entry: `MARTES (07:00:00-09:00:00)`, then `LUGAR: …`, then
  `COD. AMB.: 1-59-1-03-LC; TIPO: LABORATORIO DE COMPUTACION; PISO: 1;`. Days without accents
  (`MIERCOLES`). Table rows continue across pages (header repeated). Footer legend table on the last page.

## Decisions
- Parse server-side in the web (no external services); never store the PDF; never store personal
  header data (cédula, student name). Store only class rows + period label/end date.
- Preview + confirm before saving; re-import replaces the user's previous schedule.
- One lead time per user: 30 / 60 / 180 minutes or off (`moodle_users.class_reminder_minutes`).
- Worker sends when `now >= start - lead` and `now < start`, once per class per date.
- Reminders stop after the period end (last day of the period's final month) when known.
- The hardcoded owner schedule is only a fallback when the admin has no imported schedule.

## TDD
- Mode: off. Runners: `python -m pytest -q`; `npm test`, `npx tsc --noEmit`, `npm run build` in `web/`.

## Delivery
- Branch `feat/class-schedule-import` from main `20e211e`. RDD off. User authorized push + deploy
  when done ("súbelo y despliégalo" pattern) — confirm per action.

## Tasks
- [x] T1 Schema + worker class reminders from DB (python). Route: delegated. Commit `76b5cdc`.
  `python -m pytest -q`: 354 passed, 1 skipped; `python -c "import worker"`: ok.
  New `class_reminders.py` (process_class_reminders, title_case, class_message), `tests/test_class_reminders.py`;
  `supabase_client` fetch_class_reminder_users / fetch_class_schedule / fetch_users_with_schedule;
  `Storage.record_milestone(..., mirror=False)`; built-in schedule only for admins without rows.
- [x] T2 Web: PDF upload/parse/preview/save, lead-time setting, schedule view (web). Route: delegated. Done (uncommitted, parent commits): `/horario` + parser `lib/sga-schedule.ts` + `unpdf` dependency; nav kept at 5 items (Horario is a segment inside Recordatorios).
- [x] T3 README + deploy (VPS SQL + pull + restart, Vercel deploy). Route: inline.

## Progress / Evidence
- T2 (web): checks in `web/`: `npm test` 260 passed (26 files); `npx tsc --noEmit` clean; `npm run build` OK (`/horario` route listed).
  Parser run on the real SGA PDF (local only, nothing copied): 2 pages, 5 subjects, 8 schedule entries
  (ABD 2, DAW 2, TS 1, ACS 2 par B, IIC (EMI) 1 par B), period end 2027-01-31, 0 warnings. The same parser also ran
  inside the production Next server (`next start`) via a throwaway route, since removed.
- Real-PDF finding: cells are vertically centred in their row, so rows are split by vertical gaps between lines and
  columns by horizontal gaps between text blocks (headers are centred, body text is left aligned), not by
  "everything below the subject line".

## Next step
- VPS: git pull + run supabase_schema.sql + pm2 restart. Then the user imports their PDF in /horario.
