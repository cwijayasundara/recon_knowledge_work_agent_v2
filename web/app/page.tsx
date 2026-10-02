"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { UploadDrop } from "@/components/lenses/UploadDrop";
import { api } from "@/lib/api";

type RunRow = Awaited<ReturnType<typeof api.runs>>[number];

export default function Home() {
  const router = useRouter();
  const [sponsors, setSponsors] = useState<{ id: string; name: string }[]>([]);
  const [sponsor, setSponsor] = useState("");
  const [name, setName] = useState("analyst");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setName(window.localStorage.getItem("onb.actor") || "analyst");
    api.sponsors().then((s) => {
      setSponsors(s);
      if (s.length && !sponsor) setSponsor(s[0].id);
    }).catch((e: Error) => setError(`Cannot reach the API: ${e.message}`));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sponsor) api.runs(sponsor).then(setRuns).catch(() => setRuns([]));
  }, [sponsor]);

  async function start(file: File) {
    setStarting(true);
    setError(null);
    try {
      const { run_id } = await api.start(sponsor, file);
      router.push(`/runs/${run_id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  }

  return (
    <main className="home">
      <header className="band">
        <div>
          <div className="t">Affiliate Load</div>
          <div className="s">Affiliates are global — one file per fund complex</div>
        </div>
      </header>
      <section className="box" aria-labelledby="start-h">
        <h3 id="start-h">Start an onboarding run</h3>
        <div className="two">
          <label className="field">
            Sponsor
            <select value={sponsor} onChange={(e) => setSponsor(e.target.value)} aria-label="Sponsor">
              {sponsors.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Your name (recorded on every decision)
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                window.localStorage.setItem("onb.actor", e.target.value);
              }}
            />
          </label>
        </div>
        <div style={{ marginTop: 12 }}>
          <UploadDrop disabled={!sponsor || starting} onFile={start} />
        </div>
        {error && <p className="err-text" role="alert">{error}</p>}
      </section>
      <section className="box runs" aria-labelledby="runs-h">
        <h3 id="runs-h">Recent runs for this sponsor</h3>
        {runs.length === 0 ? (
          <p className="sd">No runs yet. Upload an affiliate file to start one.</p>
        ) : (
          <div className="tbl">
            <table style={{ minWidth: 0 }}>
              <thead><tr><th>Run</th><th>File</th><th>Status</th><th>Started</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono"><a href={`/runs/${r.id}`}>{r.id}</a></td>
                    <td>{r.upload_name}</td>
                    <td>{r.status}</td>
                    <td className="mono">{r.created_at.slice(0, 16).replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
