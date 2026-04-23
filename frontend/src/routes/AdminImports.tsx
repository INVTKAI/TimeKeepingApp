import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { humanizeError, invokeEdgeFunction } from "@/lib/problem";
import { Banner, PageHeader } from "@/components/PageHeader";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const PHASE_B_TYPES = [
  { value: "subs", label: "Subcontractors" },
  { value: "employee_subs", label: "Employee → Sub mapping" },
  { value: "project_subs", label: "Project → Sub engagements" },
  { value: "project_flows", label: "Project → Flow assignments" },
  { value: "silo_roles", label: "Silo role assignments" },
  { value: "project_roles", label: "Project role assignments" },
  { value: "timekeeper_assignments", label: "Submitter assignments" },
] as const;

type PhaseBType = (typeof PHASE_B_TYPES)[number]["value"];

export function AdminImports() {
  return (
    <div className="invenio-page">
      <PageHeader
        title="Imports"
        subtitle="Phase A: legacy localStorage blob. Phase B: curated spreadsheets."
      />

      <PhaseAImporter />
      <PhaseBImporter />
    </div>
  );
}

function useEfCall() {
  const { session } = useAuth();
  return async (name: string, body: unknown) => {
    if (!session?.access_token) throw new Error("Not signed in");
    return invokeEdgeFunction(
      SUPABASE_URL,
      name,
      body,
      session.access_token,
      ANON_KEY,
    );
  };
}

// ---- Phase A --------------------------------------------------------------

function PhaseAImporter() {
  const call = useEfCall();
  const [file, setFile] = useState<File | null>(null);
  const [importTimesheets, setImportTimesheets] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "info" | "error" | "success"; text: string } | null
  >(null);
  const [result, setResult] = useState<unknown>(null);
  const [working, setWorking] = useState(false);

  const run = async () => {
    if (!file) {
      setBanner({ kind: "error", text: "Pick a .json file first." });
      return;
    }
    setBanner(null);
    setResult(null);
    setWorking(true);
    try {
      const text = await file.text();
      const blob = JSON.parse(text);
      const r = await call("import-localstorage", {
        ...blob,
        import_timesheets: importTimesheets,
      });
      setResult(r);
      setBanner({ kind: "success", text: "Import complete." });
    } catch (err) {
      setBanner({ kind: "error", text: humanizeError(err) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="invenio-card flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Phase A · localStorage blob</h2>
      <p className="text-sm text-ink-muted">
        One-shot import of the legacy app's <span className="font-mono">
          DB.exportAll()
        </span> JSON. Idempotent via <span className="font-mono">external_id</span>;
        safe to re-run after augmentation.
      </p>

      <div>
        <label className="invenio-label">JSON file</label>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>

      <label className="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={importTimesheets}
          onChange={(e) => setImportTimesheets(e.target.checked)}
        />
        <span>
          Also import historical timesheets (as draft — see spec §9). Default off.
        </span>
      </label>

      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}

      <div>
        <button
          className="invenio-btn-primary"
          onClick={run}
          disabled={!file || working}
        >
          {working ? "Importing…" : "Run import"}
        </button>
      </div>

      {result !== null && (
        <pre className="text-xs bg-raised rounded-md p-3 overflow-x-auto font-mono max-h-96">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </section>
  );
}

// ---- Phase B --------------------------------------------------------------

function PhaseBImporter() {
  const call = useEfCall();
  const [fileType, setFileType] = useState<PhaseBType>("subs");
  const [file, setFile] = useState<File | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [banner, setBanner] = useState<
    { kind: "info" | "error" | "success"; text: string } | null
  >(null);
  const [result, setResult] = useState<unknown>(null);
  const [working, setWorking] = useState(false);

  const parseRows = async (): Promise<Record<string, unknown>[]> => {
    if (file) {
      const text = await file.text();
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".json")) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
        throw new Error(
          "JSON must be an array of row objects, or { rows: [...] }.",
        );
      }
      if (lower.endsWith(".csv")) {
        return csvToObjects(text);
      }
      throw new Error("Only .json or .csv supported here. Parse .xlsx client-side or export to CSV.");
    }
    if (jsonText.trim()) {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
      throw new Error(
        "JSON must be an array of row objects, or { rows: [...] }.",
      );
    }
    throw new Error("Upload a file or paste JSON.");
  };

  const run = async () => {
    setBanner(null);
    setResult(null);
    setWorking(true);
    try {
      const rows = await parseRows();
      const r = await call("import-spreadsheet", {
        file_type: fileType,
        rows,
      });
      setResult(r);
      setBanner({ kind: "success", text: "Import complete." });
    } catch (err) {
      setBanner({ kind: "error", text: humanizeError(err) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="invenio-card flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Phase B · curated spreadsheet</h2>
      <p className="text-sm text-ink-muted">
        Loads the spreadsheets that Phase A cannot populate — silo/project role
        assignments, flow→project mappings, etc. Each row is validated and
        errors are reported per-row; partial loads are safe to re-run.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="invenio-label">File type</label>
          <select
            className="invenio-input"
            value={fileType}
            onChange={(e) => setFileType(e.target.value as PhaseBType)}
          >
            {PHASE_B_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="invenio-label">File (.json or .csv)</label>
          <input
            type="file"
            accept=".json,.csv,application/json,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
      </div>

      <details>
        <summary className="text-sm text-brand hover:underline cursor-pointer">
          Or paste JSON directly…
        </summary>
        <textarea
          className="invenio-input min-h-[120px] py-2 font-mono text-xs mt-2"
          placeholder='[{"short_code":"ACME","name":"Acme Sub"}, …]'
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
        />
      </details>

      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}

      <div>
        <button
          className="invenio-btn-primary"
          onClick={run}
          disabled={working}
        >
          {working ? "Importing…" : "Run import"}
        </button>
      </div>

      {result !== null && (
        <pre className="text-xs bg-raised rounded-md p-3 overflow-x-auto font-mono max-h-96">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </section>
  );
}

// Minimal CSV parser — handles quoted values + escaped quotes. Good enough for
// admin-curated files; we're not trying to be a general CSV library.
function csvToObjects(text: string): Record<string, unknown>[] {
  const lines = splitCsvLines(text);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cells = parseCsvLine(raw);
    const row: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = cells[c] ?? "";
    }
    out.push(row);
  }
  return out;
}

function splitCsvLines(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      cur += ch;
      inQuote = !inQuote;
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuote) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      if (ch === "\r" && text[i + 1] === "\n") i++;
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
