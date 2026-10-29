import type { ReactNode } from "react";
import { Tag } from "@carbon/react";
import { ArrowDown, ArrowUp } from "@carbon/icons-react";
import { AGGREGATES, A_NUMBER, formatValue, PREVIOUS, widthCss, type ChartOptions, type Stat } from "../domain/chart";
import { blockHeightCss } from "../domain/views";

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
 * Carbon's heading-06 (light) with the change from the baseline beside it as a Carbon tag with an up or
 * down arrow (green where the change is good, red where bad: `better`), what it is compared with,
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
    // Fitting its content, as tall as that (a 4rem sparkline); else its Height (and Aspect ratio; a row's height in a row),
    // the number centred in what the sparkline leaves (it grows with the height: styles.css .stat-block--sized).
    <div
      className={options.fitContent ? "stat-block" : "stat-block stat-block--sized"}
      style={{ maxInlineSize: widthCss(options.width), ...(!options.fitContent && { blockSize: blockHeightCss(options.height, options.aspect) }) }}
    >
      <div className="stat-block__body">
        <div className="stat-block__text">
          {options.showLabel && <span className="stat-block__label">{stat.label}</span>}
          <div className="stat-block__value">
            <span className="stat-block__number">
              {number}
              {unit && stat.value !== null && <span className="stat-block__unit">{unit}</span>}
            </span>
            {change !== null && (
              <Tag
                size="md"
                type={stat.trend === "good" ? "green" : stat.trend === "bad" ? "red" : "gray"}
                renderIcon={stat.change! > 0 ? ArrowUp : stat.change! < 0 ? ArrowDown : undefined}
              >
                {change}
              </Tag>
            )}
          </div>
          {from && <span className="stat-block__from">Compared with {from}</span>}
        </div>
        {sparkline && <div className="stat-block__sparkline">{sparkline}</div>}
      </div>
    </div>
  );
}
