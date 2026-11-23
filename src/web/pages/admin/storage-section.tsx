import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { adminStorageDtoSchema } from "../../../shared/dto/admin.ts";
import { useApi } from "../../api/context.tsx";
import { formatBytes } from "../../../shared/units.ts";
import { SkeletonRows } from "../../ui/feedback.tsx";
import { RequestError, SettingsBlock } from "../settings/settings-ui.tsx";
import { adminKeys, useAdminUsers } from "./admin-data.ts";

/** `/admin/storage`: the data volume and each user's files against their quota. */
export function AdminStorageSection() {
  const { t } = useTranslation();
  const client = useApi();
  const storage = useQuery({ queryKey: adminKeys.storage, queryFn: () => client.get("/api/admin/storage", adminStorageDtoSchema) });
  const users = useAdminUsers();
  const nameOf = (userId: string): string => users.data?.users.find((user) => user.id === userId)?.username ?? userId;
  return (
    <SettingsBlock intro={t("admin.storage.intro")}>
      {storage.isPending ? <SkeletonRows count={3} rowHeight={20} /> : null}
      <RequestError error={storage.error} />
      {storage.data === undefined ? null : (
        <>
          <dl className="mb-4 grid grid-cols-3 gap-3 text-sm" data-testid="admin-storage-totals">
            <div>
              <dt className="text-xs text-muted">{t("admin.storage.total")}</dt>
              <dd>{formatBytes(storage.data.totalBytes)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("admin.storage.used")}</dt>
              <dd>{formatBytes(storage.data.usedBytes)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("admin.storage.free")}</dt>
              <dd>{formatBytes(storage.data.freeBytes)}</dd>
            </div>
          </dl>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="pb-1 font-medium">{t("admin.storage.user")}</th>
                <th className="pb-1 font-medium">{t("admin.storage.userUsed")}</th>
                <th className="pb-1 font-medium">{t("admin.storage.limit")}</th>
              </tr>
            </thead>
            <tbody>
              {storage.data.users.map((user) => (
                <tr key={user.userId} className="border-t border-line">
                  <td className="py-1">{nameOf(user.userId)}</td>
                  <td className="py-1">{formatBytes(user.usedBytes)}</td>
                  <td className="py-1">{user.storageLimitGB === undefined ? t("admin.users.noLimit") : `${user.storageLimitGB} GB`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </SettingsBlock>
  );
}
