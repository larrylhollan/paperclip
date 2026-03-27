// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueActionButtons, IssueHeaderActions } from "./IssueHeaderActions";

describe("IssueHeaderActions", () => {
  it("renders a dedicated mobile actions trigger so issue actions stay reachable on small screens", () => {
    const html = renderToStaticMarkup(
      <IssueHeaderActions
        copied={false}
        panelVisible={false}
        moreOpen={false}
        onMoreOpenChange={vi.fn()}
        mobileActionsOpen={false}
        onMobileActionsOpenChange={vi.fn()}
        onCopy={vi.fn()}
        onShowProperties={vi.fn()}
        onShowPanel={vi.fn()}
        onOpenJitDialog={vi.fn()}
        onHideIssue={vi.fn()}
      />,
    );

    expect(html).toContain('title="Actions"');
    expect(html).toContain('aria-label="Issue actions"');
  });

  it("renders Grant SSH Access in the shared action list used by mobile and desktop", () => {
    const html = renderToStaticMarkup(
      <IssueActionButtons layout="sheet" onGrantSsh={vi.fn()} onHideIssue={vi.fn()} />,
    );

    expect(html).toContain("Grant SSH Access");
    expect(html).toContain("Hide this Issue");
  });
});
