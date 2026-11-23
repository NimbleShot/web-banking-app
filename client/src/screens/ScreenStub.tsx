import { GlassCard } from '../components/GlassCard';
import { Page } from '../components/Page';

type ScreenStubProps = {
  title: string;
  label?: string;
  signedIn?: boolean;
  eyebrow: string;
  lead: string;
};

/** A screen's frame and headings, until its form is built. */
export function ScreenStub({ title, label, signedIn = false, eyebrow, lead }: ScreenStubProps) {
  return (
    <Page title={title} label={label} signedIn={signedIn}>
      <GlassCard>
        <span className="card-eyebrow">{eyebrow}</span>
        <h1 className="card-title">{title}</h1>
        {lead && <p className="card-lead">{lead}</p>}
      </GlassCard>
    </Page>
  );
}
