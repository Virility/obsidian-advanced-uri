import { AdvancedURISettings } from "./types";

export const DEFAULT_SETTINGS: AdvancedURISettings = {
    insertFallback: "notice",
    insertUnder: false,
    openFileOnWrite: true,
    openDailyInNewPane: false,
    openFileOnWriteInNewPane: false,
    openFileWithoutWriteInNewPane: false,
    idField: "id",
    useUID: false,
    addFilepathWhenUsingUID: false,
    includeVaultName: true,
    vaultParam: "name",
    linkFormats: [
        {
            name: "Markdown",
            format: "[{{name}}]({{uri}})",
        },
    ],
};
