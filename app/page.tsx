import { Court } from "@/components/Court";
import { HomeAbout } from "@/components/HomeAbout";
import { SiteFooter } from "@/components/SiteFooter";
import { JsonLd } from "@/components/seo/JsonLd";
import { webAppLd, websiteLd } from "@/lib/seo/jsonld";

export default function Page() {
  return (
    <>
      <JsonLd data={[websiteLd(), webAppLd()]} />
      <main id="content">
        <Court />
        <noscript>
          <p className="noscript">Hoopload needs JavaScript to run the game and upload files. Read how it works on the How it works page.</p>
        </noscript>
        <HomeAbout />
      </main>
      <SiteFooter />
    </>
  );
}
