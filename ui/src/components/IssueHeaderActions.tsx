import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Check, Copy, EyeOff, KeyRound, MoreHorizontal, SlidersHorizontal } from "lucide-react";

type IssueActionButtonsProps = {
  layout?: "menu" | "sheet";
  onGrantSsh: () => void;
  onHideIssue: () => void;
};

export function IssueActionButtons({ layout = "menu", onGrantSsh, onHideIssue }: IssueActionButtonsProps) {
  const itemClassName =
    layout === "sheet"
      ? "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent/50"
      : "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50";

  return (
    <div className={cn("space-y-1", layout === "sheet" && "px-4 pb-4 pt-2")}>
      <button
        type="button"
        className={itemClassName}
        onClick={onGrantSsh}
      >
        <KeyRound className="h-3.5 w-3.5 shrink-0" />
        Grant SSH Access…
      </button>
      <button
        type="button"
        className={cn(itemClassName, "text-destructive")}
        onClick={onHideIssue}
      >
        <EyeOff className="h-3.5 w-3.5 shrink-0" />
        Hide this Issue
      </button>
    </div>
  );
}

type IssueHeaderActionsProps = {
  copied: boolean;
  panelVisible: boolean;
  moreOpen: boolean;
  onMoreOpenChange: (open: boolean) => void;
  mobileActionsOpen: boolean;
  onMobileActionsOpenChange: (open: boolean) => void;
  onCopy: () => void;
  onShowProperties: () => void;
  onShowPanel: () => void;
  onOpenJitDialog: () => void;
  onHideIssue: () => void;
};

export function IssueHeaderActions({
  copied,
  panelVisible,
  moreOpen,
  onMoreOpenChange,
  mobileActionsOpen,
  onMobileActionsOpenChange,
  onCopy,
  onShowProperties,
  onShowPanel,
  onOpenJitDialog,
  onHideIssue,
}: IssueHeaderActionsProps) {
  return (
    <>
      <div className="ml-auto flex items-center gap-0.5 shrink-0 md:hidden">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onCopy}
          title="Copy issue as markdown"
        >
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onShowProperties}
          title="Properties"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>

        <Sheet open={mobileActionsOpen} onOpenChange={onMobileActionsOpenChange}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Actions"
              aria-label="Issue actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[60dvh] pb-[env(safe-area-inset-bottom)]">
            <SheetHeader>
              <SheetTitle className="text-sm">Issue actions</SheetTitle>
            </SheetHeader>
            <ScrollArea className="flex-1 overflow-y-auto">
              <IssueActionButtons
                layout="sheet"
                onGrantSsh={() => {
                  onMobileActionsOpenChange(false);
                  onOpenJitDialog();
                }}
                onHideIssue={() => {
                  onMobileActionsOpenChange(false);
                  onHideIssue();
                }}
              />
            </ScrollArea>
          </SheetContent>
        </Sheet>
      </div>

      <div className="hidden items-center shrink-0 md:ml-auto md:flex">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onCopy}
          title="Copy issue as markdown"
        >
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={cn(
            "shrink-0 overflow-hidden transition-opacity duration-200",
            panelVisible ? "pointer-events-none w-0 opacity-0" : "opacity-100",
          )}
          onClick={onShowPanel}
          title="Show properties"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>

        <Popover open={moreOpen} onOpenChange={onMoreOpenChange}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="shrink-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-52 p-1" align="end">
            <IssueActionButtons
              onGrantSsh={() => {
                onMoreOpenChange(false);
                onOpenJitDialog();
              }}
              onHideIssue={() => {
                onMoreOpenChange(false);
                onHideIssue();
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
    </>
  );
}
