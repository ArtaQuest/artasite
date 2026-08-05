/** The Fields page's axis configuration — its own module because Fields.tsx must export only
 *  components (react-refresh/only-export-components is an error in artasite's CI, and it is right:
 *  a non-component export from a component file breaks hot reload for the whole page). */
export type AxisCfg = { axis: "house" | "topic"; title: string; noun: string; blurb: string; base: string };

export const SKILLS_CFG: AxisCfg = {
  axis: "topic", title: "Topics", noun: "topic", base: "/topics",
  blurb: "Every OpenAlex research subfield, measured as its share of the citations the whole scholarly record received each year, the sky sampled at each year's mid-point — each field modelled on its own, over its own history since it emerged — placed in the sidereal sign its Pluto tuning falls in (Lahiri dates), ranked by model fit. Follow one sign: its topics are what we recommend you.",
};
