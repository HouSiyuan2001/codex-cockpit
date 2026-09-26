// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PersonCostArcs, PersonCostLegend } from "./PersonCostRing";
const data = { partial: true, people: [
  { id: "alex", name: "成员甲", cost: 30, share: .3, color: "purple", unassigned: false },
  { id: "blair", name: "成员乙", cost: 70, share: .7, color: "teal", unassigned: false },
] };
afterEach(cleanup);
it("splits only the filled arc, preserving unused capacity", () => {
  const { container } = render(<svg><PersonCostArcs data={data} progress={80} /></svg>);
  const circles = container.querySelectorAll("circle");
  expect(circles[0].getAttribute("stroke-dasharray")).toBe("24 76");
  expect(circles[1].getAttribute("stroke-dasharray")).toBe("56 44");
  expect(circles[1].getAttribute("stroke-dashoffset")).toBe("-24");
});
it("caps visual overflow at a full ring while retaining person shares", () => {
  const { container } = render(<svg><PersonCostArcs data={data} progress={150} /></svg>);
  expect(container.querySelector("circle")?.getAttribute("stroke-dasharray")).toBe("30 70");
});
it("shows names, cost shares and incomplete pricing in the legend", () => {
  const { container } = render(<PersonCostLegend data={data} english={false} />);
  expect(container.textContent).toContain("仅已知金额");
  expect(container.textContent).toContain("成员甲30%$30.00");
  expect(container.textContent).toContain("成员乙70%$70.00");
});
it("has an honest empty fallback and English explanation", () => {
  const { container } = render(<PersonCostLegend data={{ people: [], partial: true }} english />);
  expect(container.textContent).toBe("Waiting for cost data");
});
