---
layout: default
title: INTUITION
order: 3
icon: fas fa-stream
permalink: /intuition/
---

{% include intuition-style.html %}

<div class="intuition-page-header">
  {% include lang-switcher.html %}
</div>

<div class="intuition-intro">
  <div class="lang-block" data-lang="zh">
    <!-- <h1>INTUITION</h1> -->
    <p>理解感受的来源，带着觉察做选择。</p>
  </div>
  <div class="lang-block" data-lang="en">
    <!-- <h1>INTUITION</h1> -->
    <p>Sit with the intention and awareness. </p> 
  </div>
</div>

<div class="intuition-card-grid">
{% assign intuition_posts = site.posts | where_exp: "post", "post.categories contains 'intuition'" %}
{% if intuition_posts and intuition_posts.size > 0 %}
  {% for post in intuition_posts %}
    <article class="intuition-card">
      <a class="intuition-card-title" href="{{ post.url | relative_url }}">
        <span class="lang-block" data-lang="zh">{{ post.title_zh | default: post.title }}</span>
        <span class="lang-block" data-lang="en">{{ post.title_en | default: post.title }}</span>
      </a>
      <p class="intuition-card-excerpt">
        <span class="lang-block" data-lang="zh">{{ post.excerpt_zh | default: post.excerpt | strip_html | truncate: 250 }}</span>
        <span class="lang-block" data-lang="en">{{ post.excerpt_en | default: post.excerpt | strip_html | truncate: 250 }}</span>
      </p>
      <a class="intuition-readmore" href="{{ post.url | relative_url }}">
        <span class="lang-block" data-lang="zh">阅读全文 →</span>
        <span class="lang-block" data-lang="en">Read more →</span>
      </a>
    </article>
  {% endfor %}
{% else %}
  <div>
    <p class="lang-block" data-lang="zh">目前还没有 INTUITION 专题文章。请稍后回来查看更新。</p>
    <p class="lang-block" data-lang="en">There are no INTUITION posts yet. Please check back later for updates.</p>
  </div>
{% endif %}
</div>

<script src="{{ '/assets/js/intuition-lang-switch.js' | relative_url }}"></script>
