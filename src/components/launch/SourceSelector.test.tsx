import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { isSourceSelected, MarqueeText, SourceSelector } from "./SourceSelector";

describe("standalone source selector", () => {
	it("renders without the HUD interaction provider", () => {
		expect(() =>
			renderToStaticMarkup(
				<I18nProvider>
					<SourceSelector selectedSource="Display 1" open />
				</I18nProvider>,
			),
		).not.toThrow();
	});

	it("hides animated copies of source names from assistive technology", () => {
		const markup = renderToStaticMarkup(<MarqueeText text="Display 1" />);
		expect(markup).toContain('aria-hidden="true"');
		expect(markup.match(/Display 1/g)).toHaveLength(3);
	});
});

describe("isSourceSelected", () => {
	const first = { id: "window:1:0", name: "Untitled" };
	const second = { id: "window:2:0", name: "Untitled" };

	it("distinguishes same-named windows by id", () => {
		expect(isSourceSelected(first, "Untitled", "window:2:0")).toBe(false);
		expect(isSourceSelected(second, "Untitled", "window:2:0")).toBe(true);
	});

	it("falls back to the name when no id is known", () => {
		expect(isSourceSelected(first, "Untitled", null)).toBe(true);
		expect(isSourceSelected(first, "Display 1")).toBe(false);
	});
});
