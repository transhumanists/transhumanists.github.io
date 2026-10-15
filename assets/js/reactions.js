(function() {
  const pageKey = 'trans_reactions_' + window.location.pathname.replace(/[^a-zA-Z0-9]/g, '_');
  
  // Default data structure
  let data = {
    counts: { '👍': 14, '❤️': 22, '🚀': 9, '💡': 11, '🔥': 17 },
    userReacted: {},
    comments: [
      { author: "Aethelgard", text: "The acceleration curve here is real. Excellent synthesis.", date: "2026-10-14" },
      { author: "Node_Runner", text: "Zero telemetry policy is what keeps this network trustworthy.", date: "2026-10-15" }
    ]
  };

  try {
    const saved = localStorage.getItem(pageKey);
    if (saved) {
      data = JSON.parse(saved);
    }
  } catch(e) {}

  function save() {
    try {
      localStorage.setItem(pageKey, JSON.stringify(data));
    } catch(e) {}
  }

  const buttons = document.querySelectorAll('.reaction-btn');
  const form = document.getElementById('reaction-form');
  const authorInput = document.getElementById('comment-author');
  const textInput = document.getElementById('comment-text');
  const list = document.getElementById('comments-list');

  function render() {
    buttons.forEach(btn => {
      const emoji = btn.getAttribute('data-emoji');
      const countSpan = btn.querySelector('.count');
      countSpan.textContent = data.counts[emoji] || 0;
      if (data.userReacted[emoji]) {
        btn.classList.add('reacted');
      } else {
        btn.classList.remove('reacted');
      }
    });

    if (list) {
      list.innerHTML = '';
      data.comments.forEach(c => {
        const item = document.createElement('div');
        item.className = 'comment-item';
        item.innerHTML = `
          <div class="comment-meta">
            <span class="comment-author">${escapeHTML(c.author)}</span>
            <span class="comment-date">${c.date || 'Just now'}</span>
          </div>
          <div class="comment-body">${escapeHTML(c.text)}</div>
        `;
        list.appendChild(item);
      });
    }
  }

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.getAttribute('data-emoji');
      if (data.userReacted[emoji]) {
        data.counts[emoji] = Math.max(0, (data.counts[emoji] || 1) - 1);
        data.userReacted[emoji] = false;
      } else {
        data.counts[emoji] = (data.counts[emoji] || 0) + 1;
        data.userReacted[emoji] = true;
      }
      save();
      render();
    });
  });

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const author = authorInput.value.trim();
      const text = textInput.value.trim();
      if (!author || !text) return;

      const newComment = {
        author: author,
        text: text,
        date: new Date().toISOString().split('T')[0]
      };

      data.comments.unshift(newComment);
      save();
      render();

      authorInput.value = '';
      textInput.value = '';
    });
  }

  render();
})();
