export interface Sponsor { id: string; name: string }

export function SponsorPicker({ sponsors, value, onChange }: { sponsors: Sponsor[]; value: string; onChange: (id: string) => void }) {
  return (
    <label class="field">
      <span>Sponsor</span>
      <select data-testid="sponsor-select" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">Choose a sponsor</option>
        {sponsors.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </label>
  );
}
