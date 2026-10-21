import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "徐霞客 AI · 杭州半日漫游",
  description:
    "强调「在场感」的旅行 Agent 演示：走到哪儿，看到哪儿。地点来自飞猪检索，坐标与步行路线经高德实测校验，到站讲解是阿里云百炼智能体的真实回复；停留时长与「已到达」为模拟。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
