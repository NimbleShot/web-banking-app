const STAR_TRACKS = [1, 2, 3, 4, 5, 6];

/** The fixed scene behind every screen: grid, glows, light beams, horizon and shooting stars. */
export function Background({ centered }: { centered: boolean }) {
  return (
    <div className="background" aria-hidden="true">
      <div className="bg-grid" />
      <div className="bg-glow bg-glow-a" />
      <div className="bg-glow bg-glow-b" />
      <div className="bg-glow bg-glow-c" />
      <div className="bg-beam bg-beam-1" />
      <div className="bg-beam bg-beam-2" />
      <div className="bg-horizon" />
      {centered && <div className="bg-card-aura" />}
      {STAR_TRACKS.map((track) => (
        <div key={track} className={`star-track star-track-${track}`}>
          <div className="star" />
        </div>
      ))}
    </div>
  );
}
