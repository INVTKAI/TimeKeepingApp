# Timekeeping App

Browser-based timekeeping system for Kindred Industrial Services.

## Structure

- `index.html` — entry point
- `app.js` — UI and application logic
- `data.js` — data layer (localStorage-backed, with demo seed data)
- `styles.css` — styles
- `export_labor.py` — helper script to export labor data to XLSX
- `test_export.xlsx` — sample output from `export_labor.py`

## Usage

Open `index.html` in a modern browser — no build step or server required. Data persists in browser `localStorage`.

### Demo credentials

`data.js` seeds a set of demo users for local testing (admin + staff/timekeeper roles). These are placeholder credentials only and should be replaced before any non-local use.

## Labor export

```
python export_labor.py
```

Requires Python 3 with `openpyxl` available.
