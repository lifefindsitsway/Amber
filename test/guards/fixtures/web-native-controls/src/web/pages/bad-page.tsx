export function BadPage(props: { kind: string }) {
  return (
    <div>
      <select aria-label="pick">
        <option>a</option>
      </select>
      <input type="checkbox" aria-label="box" />
      <input type={"radio"} aria-label="radio" />
      <input type={props.kind} aria-label="dynamic" />
      <p className="rounded-md border border-danger/40 bg-danger/5 p-3">x</p>
      <p className={`rounded-md border border-accent/40 bg-accent-soft ${props.kind}`}>y</p>
      <span className="rounded bg-danger/10 text-danger">badge</span>
    </div>
  );
}
