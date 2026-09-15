import type { Metadata } from "next";
import { Archivo, Archivo_Narrow, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/chrome/app-shell";

// Terrace: Archivo for reading, Archivo Narrow for the uppercase headings and
// headline numbers. IBM Plex Mono stays for code and the older mono labels.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const archivoNarrow = Archivo_Narrow({
  variable: "--font-archivo-narrow",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "FPL Edge",
  description: "A data-driven Fantasy Premier League decision engine.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${archivoNarrow.variable} ${plexMono.variable} h-full`}
    >
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
