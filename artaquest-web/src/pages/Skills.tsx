import Fields, { SKILLS_CFG } from "./Fields";

// Learning-skills axis (axis=topic) — the skills atlas, its own 12 houses + page, separate from Professions.
export default function Skills() {
  return <Fields cfg={SKILLS_CFG} />;
}
