export async function getExistingPageHandles(admin) {
  const handles = new Set();

  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query ExistingPages($after: String) {
          pages(first: 100, after: $after) {
            nodes {
              handle
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          after: cursor,
        },
      },
    );

    const json = await response.json();

    const pages = json.data?.pages;

    if (!pages) break;

    for (const page of pages.nodes) {
      if (page.handle) {
        handles.add(page.handle);
      }
    }

    hasNextPage = pages.pageInfo.hasNextPage;
    cursor = pages.pageInfo.endCursor;
  }

  return handles;
}
