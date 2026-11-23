import { Checkbox } from "../ui/native.tsx";

export function CleanPage() {
  return (
    <div className="rounded-md border border-line bg-accent-soft">
      <Checkbox />
      <input type="text" aria-label="text" />
    </div>
  );
}
