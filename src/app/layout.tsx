import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Alarm Chert | Crypto Charts",
  description: "Free cryptocurrency charts powered by TradingView",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-950 text-white">
        <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              {/* سمت چپ: منو */}
              <nav className="flex items-center gap-5">
                <Link href="/" className="text-gray-300 hover:text-white transition text-sm">
                  Home
                </Link>
                <Link href="/watchlist" className="text-gray-300 hover:text-white transition text-sm">
                  Watchlist
                </Link>
                <Link href="/dashboard" className="text-gray-300 hover:text-white transition text-sm">
                  Charts
                </Link>
                <Link href="/alerts" className="text-gray-300 hover:text-white transition text-sm">
                  Alerts
                </Link>
              </nav>

              {/* سمت راست: اسم سایت */}
              <Link href="/" className="flex items-center gap-2">
                <span className="text-2xl font-bold bg-gradient-to-r from-orange-400 to-yellow-400 bg-clip-text text-transparent">
                  Alarm Chert
                </span>
              </Link>
            </div>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-gray-800 py-8 mt-auto">
          <div className="max-w-7xl mx-auto px-4 text-center text-gray-500 text-sm">
            <p>© 2026 Alarm Chert</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
