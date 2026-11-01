const assert = require('node:assert/strict');

exports.checkReviewRaces = async (workbench) => {
  let failure;
  await assert.rejects(workbench.backend.execute('review.files', { key: 'invalid-target' }), (error) => {
    assert.equal(error.name, 'WardenError');
    failure = new error.constructor(409, 'The workspace changed while reading.', 'review_changed');
    return true;
  });
  const review = { changeId: 'fixture', targetKey: 'working', sourceBase: '1'.repeat(40), sourceHead: '2'.repeat(40), developmentHead: '1'.repeat(40) };
  let attempts = 0;
  const pinned = { ...review, sourceHead: '3'.repeat(40) };
  const probe = {
    session: 'original',
    observedReviews: new Map(),
    reviews: new Map([['fixture', pinned]]),
    api: async () => {
      if (++attempts < 3) throw failure;
      return review;
    },
  };
  const read = () => workbench.readReview.call(probe, 'fixture');
  assert.equal(await read(), review);
  assert.equal(attempts, 3, 'a new observation retries transient workspace changes');
  assert.equal(probe.observedReviews.get('fixture'), review);
  assert.equal(probe.reviews.get('fixture'), pinned, 'read retries never authorize a newer delivery');

  attempts = 0;
  probe.api = async () => {
    attempts++;
    throw failure;
  };
  await assert.rejects(read(), (error) => error === failure);
  assert.equal(attempts, 3, 'continuously changing workspaces have a bounded retry budget');

  attempts = 0;
  probe.api = async () => {
    attempts++;
    probe.session = 'replacement';
    throw failure;
  };
  assert.equal(await read(), undefined);
  assert.equal(attempts, 1, 'a repository switch abandons the obsolete read');
  assert.equal(probe.observedReviews.get('fixture'), review);
  console.log('Review reads recover from transient changes without advancing pinned reviews');
};
