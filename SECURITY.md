# Security

Faultline reads local diagnostics and stores original evidence. Do not paste secrets into a public issue. If GitHub private vulnerability reporting is enabled for this repository, use **Report a vulnerability** on the Security tab. Otherwise, contact the repository owner through their GitHub profile to arrange a private report.

Security boundary for this initial Linux source build: one local user, a loopback-only foreground server, a one-time launch token exchanged for a local session, restricted diagnostic collectors, and no outbound AI requests. It does not defend against root, a compromised user account, or a malicious browser extension with access to local pages. Diagnostic content is untrusted data and is not executed. This build has not passed the full public-release validation described in the architecture document.

Security fixes should include a regression test for the affected boundary. Before publishing a report, remove credentials, private paths, and sensitive logs from reproductions.
