"use client";

import { useState } from "react";

export function UploadDrop({ onFile, disabled }: { onFile: (f: File) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`drop${over ? " over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f && !disabled) onFile(f);
      }}
    >
      <p style={{ margin: "0 0 8px" }}>Drop the Investran affiliate export here (CSV, XLSX or XLS)</p>
      {/* A label opens the native picker in every browser; a scripted click on an off-screen input does not. */}
      <label className={`btn pri${disabled ? " disabled" : ""}`} aria-disabled={disabled}>
        Choose file
        <input
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls"
          className="sr"
          aria-label="Upload source file"
          data-testid="upload"
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Reset so choosing the same file again still fires a change.
            e.target.value = "";
            if (f) onFile(f);
          }}
        />
      </label>
    </div>
  );
}
