import type { ReactNode } from "react";
import { Tag } from "@carbon/react";
import { ArrowDown, ArrowUp } from "@carbon/icons-react";
import { AGGREGATES, A_NUMBER, formatValue, PREVIOUS, type ChartOptions, type Stat } from "../domain/chart";

/** "+2.1 kg", "−3%": a change with its sign (a minus sign, not a hyphen). */
function signed(n: number, text: string): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${text}`;
}

/** What the change is from: "the average (70.2 kg)", "the previous value (69 kg)", "70 kg". */
function baselineText(options: ChartOptions, baseline: number): string {
  const value = formatValue(baseline, options);
  if (options.compare === A_NUMBER.value) return value;
  const name = (options.compare === PREVIOUS.value ? PREVIOUS.text : (AGGREGATES.find((a) => a.value === options.compare)?.text ?? "")).toLowerCase();
  return `the ${name} (${value})`;
}

/**
 * A stat (a Grafana-like stat panel, built of Carbon parts), centred: the value's name, the number in
 * Carbon's heading-06 (light), below it the change from the baseline as a Carbon tag with an up or
 * down arrow (green where the change is good, red where bad: `better`) and what it is compared with,
 * and its sparkline (`sparkline`: a compact Carbon chart, or nothing) across the whole width below.
 */
export function StatView({ stat, options, sparkline }: { stat: Stat; options: ChartOptions; sparkline: ReactNode }) {
  const unit = options.unit.trim();
  const number = stat.value === null ? "–" : formatValue(stat.value, { unit: "", decimals: options.decimals });
  const change =
    stat.change === null
      ? null
      : options.changeAs === "percent" && stat.percent !== null
        ? signed(stat.change, `${formatValue(Math.abs(stat.percent), { unit: "", decimals: options.decimals ?? 1 })}%`)
        : signed(stat.change, formatValue(Math.abs(stat.change), options));
  const from = stat.baseline === null ? "" : baselineText(options, stat.baseline);
  return (
    <div className="stat-block" style={{ maxInlineSize: `${options.width}rem` }}>
      <div className="stat-block__body">
        <div className="stat-block__text">
          <span className="stat-block__label">{stat.label}</span>
          <span className="stat-block__number">
            {number}
            {unit && stat.value !== null && <span className="stat-block__unit">{unit}</span>}
          </span>
          {change !== null && (
            <div className="stat-block__change">
              <Tag
                size="md"
                type={stat.trend === "good" ? "green" : stat.trend === "bad" ? "red" : "gray"}
                renderIcon={stat.change! > 0 ? ArrowUp : stat.change! < 0 ? ArrowDown : undefined}
              >
                {change}
              </Tag>
              <span className="stat-block__from">from {from}</span>
            </div>
          )}
        </div>
        {sparkline && <div className="stat-block__sparkline">{sparkline}</div>}
      </div>
    </div>
  );
}
