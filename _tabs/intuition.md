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
    <p>这里是 INTUITION 专题页。从这里可以浏览所有属于 <strong>intuition</strong> 分类的文章。使用右上角的语言开关，在中文、English 和原文之间自由切换。</p>
  </div>
  <div class="lang-block" data-lang="or">
    <!-- <h1>INTUITION</h1> -->
    <p>这里是 INTUITION 专题页。从这里可以浏览所有属于 <strong>intuition</strong> 分类的文章。使用右上角的语言开关，在中文、English 和原文之间自由切换。</p>
  </div>
  <div class="lang-block" data-lang="en">
    <!-- <h1>INTUITION</h1> -->
    <p>Welcome to the INTUITION page. Browse all posts categorized under <strong>intuition</strong> here. Use the language switcher in the top-right corner to switch between Chinese, English and Original.</p>
  </div>
</div>

<div class="intuition-card-grid">
{% assign intuition_posts = site.posts | where_exp: "post", "post.categories contains 'intuition'" %}
{% if intuition_posts and intuition_posts.size > 0 %}
  {% for post in intuition_posts %}
    <article class="intuition-card">
      <a class="intuition-card-title" href="{{ post.url | relative_url }}">
        <span class="lang-block" data-lang="zh">{{ post.title_zh | default: post.title }}</span>
        <span class="lang-block" data-lang="or">{{ post.title_or | default: post.title_zh | default: post.title }}</span>
        <span class="lang-block" data-lang="en">{{ post.title_en | default: post.title }}</span>
      </a>
      <p class="intuition-card-excerpt">
        <span class="lang-block" data-lang="zh">{{ post.excerpt_zh | default: post.excerpt | strip_html | truncate: 250 }}</span>
        <span class="lang-block" data-lang="or">{{ post.excerpt_or | default: post.excerpt_zh | default: post.excerpt | strip_html | truncate: 250 }}</span>
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
