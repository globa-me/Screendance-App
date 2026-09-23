import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { MarqueeText, SourceSelector } from "./SourceSelector";

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
