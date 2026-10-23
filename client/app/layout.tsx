import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { APP_NAME } from '@/lib/brand';
import { FlagEmojis } from './FlagEmojis';

const inter = Inter({ subsets: ['latin'] });
const FLAG_FONT = 'Twemoji Country Flags';

export const metadata: Metadata = {
  title: `${APP_NAME} — WhatsApp Business SaaS`,
  description: 'Shared inbox, broadcasts and automations on official WhatsApp Cloud API',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The flag font comes first but covers only flag characters (see FlagEmojis), so all other text stays Inter
    <html lang="en" className={inter.className} style={{ fontFamily: `"${FLAG_FONT}", ${inter.style.fontFamily}` }} suppressHydrationWarning>
      <body className="h-full overflow-hidden" suppressHydrationWarning>
        <FlagEmojis font={FLAG_FONT} />
        {children}
      </body>
    </html>
  );
}
