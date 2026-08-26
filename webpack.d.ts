export declare function currentCommit(cwd?: string): string

export declare function buildCommitDefinePlugin(options?: {
    /** Global to define. Default 'BUILD_COMMIT'. */
    name?: string
    /** Where to ask git. Default process.cwd(). */
    cwd?: string
    /** Webpack module, when it is not resolvable from this package. */
    webpack?: unknown
}): unknown
