import { Link } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

const groups = [
  {
    title: "Create pages",
    pages: [
      {
        title: "Create YMMT Pages",
        description:
          "Upload vehicle data, choose a product, review your selection and create pages in bulk.",
        to: "/app/upload",
        action: "Start Creating",
      },
    ],
  },
  {
    title: "Manage and correct pages",
    pages: [
      {
        title: "Manage Pages",
        description:
          "Find pages using filters or corrected JSON, then select pages to update or delete.",
        to: "/app/manage",
        action: "Search Pages",
      },
      {
        title: "Scan Pages",
        description:
          "Check for missing or incorrect vehicle values. View scan logs and export flagged pages as CSV or JSON.",
        to: "/app/scan-pages",
        action: "Open Scan Pages",
      },
      {
        title: "Page Update Jobs",
        description:
          "Open saved updates, follow progress and logs, pause or resume, retry failures and download updated pages CSV.",
        to: "/app/page-updates",
        action: "View Update Jobs",
      },
      {
        title: "Recent Change Sessions",
        description:
          "Review previous page updates, product handle changes and deletions, with links to each session’s details.",
        to: "/app/change-sessions",
        action: "View Change Sessions",
      },
    ],
  },
  {
    title: "SEO and feeds",
    pages: [
      {
        title: "SEO Meta",
        description:
          "Review and update SEO titles and descriptions for your YMMT pages.",
        to: "/app/seo",
        action: "Open SEO Meta",
      },
      {
        title: "Google Feed",
        description:
          "Choose vehicle years, create an XML feed and download exports for Google Merchant Center.",
        to: "/app/google-feed",
        action: "Open Google Feed",
      },
    ],
  },
];

const workflows = [
  {
    title: "Create new pages",
    steps: [
      "Upload data",
      "Choose product",
      "Filter and review",
      "Create pages",
      "Follow progress",
    ],
  },
  {
    title: "Correct existing pages",
    steps: [
      "Scan and export",
      "Prepare corrected JSON",
      "Search and select",
      "Update and follow logs",
      "Download updated CSV",
    ],
  },
];

export default function Index() {
  return (
    <s-page heading="YMMT Page Builder">
      <style>{`
        .ymmt-dashboard { display: grid; gap: 24px; }
        .ymmt-dashboard h2 { font-size: 18px; margin: 0 0 12px; }
        .ymmt-dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 14px; }
        .ymmt-dashboard-card { background: #fff; border: 1px solid #e3e3e3; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; align-items: flex-start; }
        .ymmt-dashboard-card h3 { font-size: 16px; margin: 0; }
        .ymmt-dashboard-card p { color: #616161; line-height: 1.5; margin: 8px 0 18px; flex: 1; }
        .ymmt-dashboard-link { display: inline-block; background: #303030; color: #fff; text-decoration: none; padding: 10px 14px; border-radius: 8px; font-weight: 600; }
        .ymmt-dashboard-link:hover { background: #484848; }
        .ymmt-dashboard-link:focus-visible { outline: 3px solid #005bd3; outline-offset: 3px; }
        .ymmt-dashboard-workflows { background: #fff; border: 1px solid #e3e3e3; border-radius: 12px; padding: 20px; display: grid; gap: 18px; }
        .ymmt-dashboard-steps { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 10px 0 0; }
        .ymmt-dashboard-steps li { background: #f5f5f5; border-radius: 6px; padding: 8px 10px; }
      `}</style>
      <div className="ymmt-dashboard">
        <p style={{ margin: 0, color: "#616161" }}>
          Create, scan and correct vehicle fitment pages, then manage SEO and
          Google Merchant Center feeds.
        </p>
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h2>{group.title}</h2>
            <div className="ymmt-dashboard-grid">
              {group.pages.map((page) => (
                <article className="ymmt-dashboard-card" key={page.to}>
                  <h3>{page.title}</h3>
                  <p>{page.description}</p>
                  <Link className="ymmt-dashboard-link" to={page.to}>
                    {page.action}
                  </Link>
                </article>
              ))}
            </div>
          </section>
        ))}
        <section
          className="ymmt-dashboard-workflows"
          aria-label="Page workflows"
        >
          {workflows.map((workflow) => (
            <div key={workflow.title}>
              <strong>{workflow.title}</strong>
              <ol className="ymmt-dashboard-steps">
                {workflow.steps.map((step, index) => (
                  <li key={step}>
                    {index + 1}. {step}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      </div>
    </s-page>
  );
}
