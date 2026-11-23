const HINT = "rounded-md border border-accent/40 bg-accent/5 p-3";

export function AllowedPage() {
  return (
    <div className={HINT}>
      <select aria-label="one" />
      <select aria-label="two" />
      <input type="checkbox" aria-label="box" />
    </div>
  );
}
