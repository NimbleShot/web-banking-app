import { GlassCard } from '../components/GlassCard';
import { Page } from '../components/Page';

type ScreenStubProps = {
  title: string;
  label?: string;
  hero?: boolean;
  eyebrow: string;
  lead: string;
};

/** A screen's frame and headings, until its form is built. */
export function ScreenStub({ title, label, hero = false, eyebrow, lead }: ScreenStubProps) {
  const Heading = hero ? 'h2' : 'h1';
  return (
    <Page title={title} label={label} hero={hero}>
      <GlassCard>
        <span className="card-eyebrow">{eyebrow}</span>
        <Heading className="card-title">{title}</Heading>
        {lead && <p className="card-lead">{lead}</p>}
      </GlassCard>
    </Page>
  );
}
