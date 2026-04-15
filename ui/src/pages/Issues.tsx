import { useEffect, useMemo, useCallback, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { CircleDot } from "lucide-react";

export function buildIssuesSearchUrl(currentHref: string, search: string): string | null {
  const url = new URL(currentHref);
  const currentSearch = url.searchParams.get("q") ?? "";
  if (currentSearch === search) return null;

  if (search.length > 0) {
    url.searchParams.set("q", search);
  } else {
    url.searchParams.delete("q");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

const DEFAULT_ACTIVE_STATUS = "backlog,todo,in_progress,in_review,blocked";
const ALL_STATUSES = ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"] as const;

function readPersistedStatusFilter(companyId: string | null): string | undefined {
  if (!companyId) return DEFAULT_ACTIVE_STATUS;
  try {
    const raw = localStorage.getItem(`paperclip:issues-view:${companyId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.statuses)) {
        return parsed.statuses.length > 0 ? parsed.statuses.join(",") : undefined;
      }
    }
  } catch {}
  return DEFAULT_ACTIVE_STATUS;
}

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  const initialAssignees = searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined;

  const [apiStatusFilter, setApiStatusFilter] = useState<string | undefined>(() =>
    initialAssignees ? undefined : readPersistedStatusFilter(selectedCompanyId ?? null)
  );

  const handleViewStatusChange = useCallback((statuses: string[]) => {
    setApiStatusFilter(statuses.length > 0 ? statuses.join(",") : undefined);
  }, []);
  const handleSearchChange = useCallback((search: string) => {
    const nextUrl = buildIssuesSearchUrl(window.location.href, search);
    if (!nextUrl) return;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Issues",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Issues" }]);
  }, [setBreadcrumbs]);

  // When no status filter is active, fetch each status in parallel (100 per status)
  const parallelResults = useQueries({
    queries: !apiStatusFilter && selectedCompanyId
      ? ALL_STATUSES.map((status) => ({
          queryKey: [...queryKeys.issues.list(selectedCompanyId), "per-status", status, "participant-agent", participantAgentId ?? "__all__"],
          queryFn: () => issuesApi.list(selectedCompanyId, { participantAgentId, status, limit: 100, includeRoutineExecutions: true }),
        }))
      : [],
  });

  // When a specific status filter is active, single call with limit 100
  const singleResult = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "participant-agent", participantAgentId ?? "__all__", "status", apiStatusFilter ?? "__all__"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { participantAgentId, status: apiStatusFilter, limit: 100 }),
    enabled: !!selectedCompanyId && !!apiStatusFilter,
  });

  const issues = useMemo(() => {
    if (apiStatusFilter) return singleResult.data;
    const seen = new Set<string>();
    const merged: Issue[] = [];
    for (const result of parallelResults) {
      for (const issue of result.data ?? []) {
        if (!seen.has(issue.id)) {
          seen.add(issue.id);
          merged.push(issue);
        }
      }
    }
    return merged;
  }, [apiStatusFilter, singleResult.data, parallelResults]);

  const isLoading = apiStatusFilter
    ? singleResult.isLoading
    : parallelResults.some((r) => r.isLoading);
  const error = apiStatusFilter
    ? singleResult.error
    : (parallelResults.find((r) => r.error)?.error ?? null);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issues." />;
  }

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      viewStateKey="paperclip:issues-view"
      issueLinkState={issueLinkState}
      initialAssignees={initialAssignees}
      initialSearch={initialSearch}
      onSearchChange={handleSearchChange}
      enableRoutineVisibilityFilter
      onViewStatusChange={handleViewStatusChange}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      searchFilters={participantAgentId ? { participantAgentId } : undefined}
    />
  );
}
