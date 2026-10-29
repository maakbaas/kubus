import { useLayoutEffect, useRef, type ReactNode } from "react";
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
 * and its sparkline (`sparkline`: a compact Carbon chart, or nothing) across the whole width below. As tall as its Height
 * (and Aspect ratio; in a row side by side, the row's): the text centred in what the sparkline leaves, the sparkline
 * growing with the height (styles.css). Never less tall than its text and a 4rem sparkline: that least height is also
 * what its row may not go below (`data-row-min`, views/BlockRows.tsx).
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
  // Its least height: the space above, its text, and (with one) the gap and a 4rem sparkline. Set on it, not a render.
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const withLine = !!sparkline;
  useLayoutEffect(() => {
    const el = box.current;
    const t = text.current;
    if (!el || !t) return;
    const update = () => {
      const cs = getComputedStyle(el);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const gap = parseFloat(getComputedStyle(t.parentElement!).rowGap) || 0;
      const least = Math.ceil(parseFloat(cs.paddingBlockStart) + t.offsetHeight + (withLine ? gap + 4 * rem : 0));
      el.style.minBlockSize = `${least}px`;
      el.dataset.rowMin = String(least);
    };
    const sizes = new ResizeObserver(update);
    sizes.observe(t);
    update();
    return () => sizes.disconnect();
  }, [withLine]);
  return (
    <div ref={box} className="stat-block" style={{ maxInlineSize: widthCss(options.width), blockSize: blockHeightCss(options.height, options.aspect) }}>
      <div className="stat-block__body">
        <div ref={text} className="stat-block__text">
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
