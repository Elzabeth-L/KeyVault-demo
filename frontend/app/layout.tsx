import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
  title: "VaultDesk",
  description: "Secure workspace powered by FastAPI, Next.js, Azure Key Vault, Cosmos DB, and AKS Workload Identity"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
