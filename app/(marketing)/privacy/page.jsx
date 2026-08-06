import LegalPage from "../LegalPage";

export const dynamic = "force-static";

export const metadata = {
  title: "Privacy Policy — 1Resume",
  description:
    "What 1Resume collects, who processes it, and how to get it deleted.",
};

const CONTACT = "support@1resume.app";

export default function PrivacyPage() {
  return (
    <LegalPage eyebrow="Legal" title="Privacy Policy" updated="August 6, 2026">
      <div className="legal-callout">
        <p>
          <strong>The short version.</strong>{" "}
          We collect your email and whatever you write about your work history. Your resume text is sent to an AI
          provider so it can be reviewed and tailored — that is the product. We
          don&rsquo;t sell your data, and you can delete your account and
          everything in it from Settings at any time.
        </p>
      </div>

      <h2>Who we are</h2>
      <p>
        1Resume (&ldquo;we&rdquo;, &ldquo;us&rdquo;) operates{" "}
        <a href="https://www.1resume.app">www.1resume.app</a>. This policy covers
        the website and the application. Questions about anything here go to{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your email address.</strong> Required — it is how you sign in.
          There are no passwords; we email you a one-time link instead.
        </li>
        <li>
          <strong>Your work history and profile.</strong> Everything you write or
          import: roles, dates, descriptions, education, skills, and the contact
          details you choose to put on a resume.
        </li>
        <li>
          <strong>Resumes you upload.</strong> Files you import, including PDFs
          and images, and the text extracted from them.
        </li>
        <li>
          <strong>Job descriptions.</strong> Text you paste, and the content of
          job pages you ask us to fetch by URL.
        </li>
        <li>
          <strong>Generated resumes</strong> and the answers you give to clarity
          and gap-review questions.
        </li>
        <li>
          <strong>Usage records.</strong> Which features you ran and when, so we
          can enforce plan limits and improve the product.
        </li>
        <li>
          <strong>Billing details.</strong> Handled entirely by Stripe. We never
          see or store your card number.
        </li>
        <li>
          <strong>Advertising click identifiers.</strong> If you arrive from a
          Google ad, we store the click id (<code>gclid</code>) in a cookie for
          up to 90 days so we can tell which ads lead to signups.
        </li>
      </ul>

      <h2>How your resume content is used</h2>
      <p>
        To review, expand, and tailor your experience, we send the relevant parts
        of your profile and the job description to a large language model
        provider. This is the core function of the product and cannot be turned
        off while using those features. You choose the provider in Settings.
      </p>
      <p>
        We instruct these models to work only from what you have written — to
        select and rephrase your real experience, never to invent employers,
        dates, metrics, or qualifications. That constraint is enforced in our
        prompts and covered by automated tests, but AI output should still be
        read before you send it anywhere.
      </p>

      <h2>Who processes your data</h2>
      <div className="legal-scroll">
        <table className="legal-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>What it handles</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Supabase</td>
              <td>Accounts, authentication, and all stored profile data</td>
            </tr>
            <tr>
              <td>Vercel</td>
              <td>Hosting and request logs</td>
            </tr>
            <tr>
              <td>Stripe</td>
              <td>Subscriptions and payments (card data never reaches us)</td>
            </tr>
            <tr>
              <td>Resend</td>
              <td>Delivery of sign-in and account emails</td>
            </tr>
            <tr>
              <td>Firecrawl</td>
              <td>Fetching a job posting when you paste its URL</td>
            </tr>
            <tr>
              <td>Mistral</td>
              <td>Reading text out of resume files you upload (OCR)</td>
            </tr>
            <tr>
              <td>Anthropic, OpenAI, Google, xAI</td>
              <td>
                Generating and reviewing resume content. Which one receives your
                text depends on the provider selected in Settings.
              </td>
            </tr>
            <tr>
              <td>Google Ads</td>
              <td>
                Measuring which ads lead to signups. Receives that a conversion
                happened and the click id — not your resume content.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        These providers process data on our behalf under their own terms. We do
        not sell your personal information, and we do not share your resume
        content with advertisers.
      </p>

      <h2>Cookies</h2>
      <p>We use cookies for two things:</p>
      <ul>
        <li>
          <strong>Keeping you signed in.</strong> Strictly necessary; the app
          does not work without them.
        </li>
        <li>
          <strong>Advertising measurement.</strong> Google Ads conversion
          tracking, and the click-id cookie described above. Blocking these
          affects nothing you can see.
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <p>
        Your profile stays until you delete it. Delete your account in Settings
        and your profile, work history, imported resumes, and generated resumes
        are removed. Some records we are required to keep — billing history in
        particular — remain with Stripe under their retention rules. Backups roll
        off within 30 days.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          <strong>Export.</strong> Settings has a profile export; your data comes
          out in a file you own.
        </li>
        <li>
          <strong>Delete.</strong> Settings has account deletion. It is immediate
          and not reversible.
        </li>
        <li>
          <strong>Access or correction.</strong> Everything we hold about you is
          visible and editable in the app. For anything else, email{" "}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </li>
      </ul>
      <p>
        Depending on where you live you may have additional rights — to a copy of
        your data, to object to processing, or to complain to a regulator. Write
        to us and we&rsquo;ll honor them.
      </p>

      <h2>Children</h2>
      <p>
        1Resume is not intended for anyone under 16, and we do not knowingly
        collect their information.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes materially we will update the date at the top and,
        for anything that affects how your data is used, email you before it
        takes effect.
      </p>
    </LegalPage>
  );
}
