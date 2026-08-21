import { canonicalizeUrl } from "./source-discovery.mjs";

export function normalizedJobText(value) {
  return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function softJobIdentity(job) {
  const structuredLocation = (job?.workLocations || job?.regions || [])
    .map((region) => `${region.provinceCode || "CN"}:${region.cityCode || "ALL"}`)
    .sort()
    .join(",");
  return [normalizedJobText(job?.company), normalizedJobText(job?.title), structuredLocation || normalizedJobText(job?.location)].join("|");
}

export function isGenericJobUrl(value) {
  const canonical = canonicalizeUrl(value);
  if (!canonical) return true;
  const url = new URL(canonical);
  const segments = url.pathname.split("/").filter(Boolean);
  const last = String(segments.at(-1) || "").toLowerCase().replace(/\.(?:html?|aspx?|php)$/i, "");
  const generic = new Set(["", "apply", "career", "careers", "job", "jobs", "opening", "openings", "position", "positions", "recruit", "recruitment"]);
  const hasJobKey = [...url.searchParams.keys()].some((key) => /(?:^|_)(?:id|jobid|job_id|jid|positionid|position_id|zpgwid)$/i.test(key));
  if (hasJobKey) return false;
  if (last === "apply" && segments.length >= 2) {
    const parent = String(segments.at(-2) || "").toLowerCase();
    return generic.has(parent);
  }
  return segments.length === 0 || generic.has(last);
}

function hasCompatibleStrongIdentity(left, right) {
  const leftCompany = normalizedJobText(left?.company);
  const rightCompany = normalizedJobText(right?.company);
  const leftTitle = normalizedJobText(left?.title);
  const rightTitle = normalizedJobText(right?.title);
  if (!leftCompany || !rightCompany || !leftTitle || !rightTitle) return false;
  if (leftCompany !== rightCompany || leftTitle !== rightTitle) return false;
  const leftLocation = softJobIdentity({ company: "", title: "", location: left?.location, workLocations: left?.workLocations, regions: left?.regions }).split("|")[2];
  const rightLocation = softJobIdentity({ company: "", title: "", location: right?.location, workLocations: right?.workLocations, regions: right?.regions }).split("|")[2];
  return !leftLocation || !rightLocation || leftLocation === rightLocation;
}

export function sameSourceExternalIdConflict(left, right) {
  if (!left || !right || String(left.sourceId || "") !== String(right.sourceId || "")) return false;
  const leftExternalId = left.externalId === null || left.externalId === undefined ? "" : String(left.externalId);
  const rightExternalId = right.externalId === null || right.externalId === undefined ? "" : String(right.externalId);
  if (!leftExternalId || leftExternalId !== rightExternalId) return false;
  const leftApplyUrl = canonicalizeUrl(left.applyUrl);
  const rightApplyUrl = canonicalizeUrl(right.applyUrl);
  // URL rotation or a title edit alone can be a legitimate update. Treat it as
  // an identifier collision only when the explicit URL and strong identity
  // both disagree.
  return Boolean(
    leftApplyUrl
    && rightApplyUrl
    && (leftApplyUrl !== rightApplyUrl || isGenericJobUrl(leftApplyUrl))
    && !hasCompatibleStrongIdentity(left, right)
  );
}

export function jobsCanExactMerge(left, right) {
  if (!left || !right) return false;
  const sameSource = String(left.sourceId || "") === String(right.sourceId || "");
  const leftExternalId = left.externalId === null || left.externalId === undefined ? "" : String(left.externalId);
  const rightExternalId = right.externalId === null || right.externalId === undefined ? "" : String(right.externalId);
  if (sameSource && leftExternalId && rightExternalId) {
    return leftExternalId === rightExternalId && !sameSourceExternalIdConflict(left, right);
  }

  const leftApplyUrl = canonicalizeUrl(left.applyUrl);
  const rightApplyUrl = canonicalizeUrl(right.applyUrl);
  if (!leftApplyUrl || leftApplyUrl !== rightApplyUrl) return false;
  if (left.urlIdentity === "source_fallback" || right.urlIdentity === "source_fallback") return false;
  // A generic application/list URL is not a sufficient job identity. In
  // particular, two records from one feed with conflicting external IDs must
  // never collapse merely because the publisher reused an apply URL.
  if (sameSource && leftExternalId && rightExternalId && leftExternalId !== rightExternalId) return false;
  return hasCompatibleStrongIdentity(left, right);
}

export function exactJobMergeKey(left, right) {
  const sameSource = String(left?.sourceId || "") === String(right?.sourceId || "");
  const leftExternalId = left?.externalId === null || left?.externalId === undefined ? "" : String(left.externalId);
  const rightExternalId = right?.externalId === null || right?.externalId === undefined ? "" : String(right.externalId);
  if (sameSource && leftExternalId && leftExternalId === rightExternalId) {
    return `source:${left.sourceId}:external:${leftExternalId}`;
  }
  return `apply:${canonicalizeUrl(left?.applyUrl) || canonicalizeUrl(right?.applyUrl) || "unknown"}`;
}
