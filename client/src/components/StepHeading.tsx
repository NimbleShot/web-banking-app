/** The "STEP 01 / 02" line with its two progress bars. */
export function StepHeading({ step }: { step: 1 | 2 }) {
  return (
    <div className="step-row">
      <span className="card-eyebrow step-label">{`STEP 0${step} / 02`}</span>
      <div className="step-bars" aria-hidden="true">
        <span className="step-bar step-bar-on" />
        <span className={`step-bar ${step === 2 ? 'step-bar-on' : ''}`} />
      </div>
    </div>
  );
}
