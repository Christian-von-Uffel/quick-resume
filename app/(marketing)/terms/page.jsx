import LegalPage from "../LegalPage";
import { MONTHLY_PRICE } from "../../../src/lib/constants";

export const dynamic = "force-static";

export const metadata = {
  title: "Terms of Service — 1Resume",
  description:
    "The terms covering your 1Resume subscription, trial, and use of the app.",
};

const CONTACT = "support@1resume.app";

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of Service"
      updated="August 6, 2026"
    >
      <div className="legal-callout">
        <p>
          <strong>The short version.</strong> ${MONTHLY_PRICE} a month after a
          14-day free trial. Your card is collected up front but not charged
          until the trial ends. Cancel any time before day 14 and you pay
          nothing. One trial per account. Your work is yours; the AI helps you
          present it, and you are responsible for what you send to employers.
        </p>
      </div>

      <h2>Agreement</h2>
      <p>
        These terms are between you and 1Resume and cover your use of{" "}
        <a href="https://www.1resume.app">www.1resume.app</a>. Creating an
        account means you accept them. If you don&rsquo;t, don&rsquo;t use the
        service.
      </p>

      <h2>Your account</h2>
      <p>
        Sign-in is passwordless: we email a one-time link. Anyone with access to
        your inbox can therefore get into your account, so keep it secure. You
        must be at least 16 years old and provide an email address you control.
        One person, one account.
      </p>

      <h2>The trial</h2>
      <ul>
        <li>New accounts get 14 days of full access at no charge.</li>
        <li>
          A payment method is required to start the trial. It is not charged
          during the trial.
        </li>
        <li>
          We email a reminder around day 12, before the first charge.
        </li>
        <li>
          Cancel before the trial ends and you are never charged. Cancel after
          and you keep access through the period you paid for.
        </li>
        <li>
          <strong>One trial per account.</strong> Cancelling and resubscribing
          does not start a new one.
        </li>
      </ul>

      <h2>Subscription and billing</h2>
      <p>
        After the trial, 1Resume is <strong>${MONTHLY_PRICE} per month</strong>,
        billed automatically to the payment method on file until you cancel.
        Payments are processed by Stripe. Cancel any time from Settings, which
        opens the Stripe billing portal; cancellation takes effect at the end of
        the current billing period and access continues until then.
      </p>
      <p>
        Charges already made are non-refundable except where the law requires
        otherwise, though if something went genuinely wrong, write to{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>{" "}
        and we&rsquo;ll sort it out. We may change the price with at least 30 days&rsquo; notice by email;
        continuing to subscribe after that is acceptance of the new price.
      </p>

      <h2>Usage limits</h2>
      <p>
        The subscription includes generous but finite monthly usage — currently
        50 tailored resume generations per month, along with limits on imports,
        clarity reviews, and gap reviews. These exist because each one runs a
        paid AI model on your behalf. We&rsquo;ll tell you if you approach them,
        and we may adjust them with notice.
      </p>

      <h2>Your content</h2>
      <p>
        Your work history, resumes, and everything you write remain yours. You
        grant us only the permission needed to run the service: to store your
        content, and to send the relevant parts to the AI providers described in
        our <a href="/privacy">Privacy Policy</a> so the product can review and
        tailor it. We do not use your content to train AI models.
      </p>
      <p>
        You are responsible for having the right to upload what you upload, and
        for the accuracy of what you say about yourself.
      </p>

      <h2>AI output</h2>
      <p>
        1Resume is designed to work only from experience you have entered and
        confirmed. It selects and rephrases your real history rather than
        inventing new claims, and we enforce that in how the models are
        instructed. Even so, AI can make mistakes: it may misread a date,
        overstate a result, or garble a sentence.
      </p>
      <p>
        <strong>Read every resume before you send it.</strong> A resume you
        submit to an employer is your statement about yourself, not ours. We make
        no promise that using 1Resume will get you interviews, offers, or a job,
        and we are not responsible for hiring outcomes.
      </p>

      <h2>Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the service to misrepresent someone&rsquo;s qualifications</li>
        <li>Upload content you have no right to use</li>
        <li>
          Attempt to break, overload, scrape, or reverse-engineer the service
        </li>
        <li>Resell access or share one account across multiple people</li>
        <li>Use it for anything unlawful</li>
      </ul>
      <p>
        We may suspend or terminate accounts that do these things, with a refund
        of any unused prepaid period unless the breach was serious.
      </p>

      <h2>Availability</h2>
      <p>
        We aim to keep 1Resume running but do not guarantee uninterrupted
        service. Features may change or be withdrawn. We depend on third-party
        providers, and their outages become ours. The service is provided
        &ldquo;as is&rdquo;, without warranties beyond those the law does not let
        us disclaim.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, our total liability for any claim relating
        to the service is limited to the amount you paid us in the 12 months
        before the claim. We are not liable for indirect or consequential losses,
        including lost job opportunities or lost earnings.
      </p>

      <h2>Ending things</h2>
      <p>
        You can cancel your subscription or delete your account at any time from
        Settings. Deleting your account removes your data as described in the{" "}
        <a href="/privacy">Privacy Policy</a> and is not reversible — export
        anything you want to keep first.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms. Material changes will be emailed to you before
        they take effect, and the date at the top will change. Continuing to use
        1Resume after that means you accept the update.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </LegalPage>
  );
}
