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
    <p>在读以下任何内容之前，我希望你带着自己的觉察、思考和感受。<br><br>
    如果读的过程中有什么浮现出来，不确定的时候，问自己一个问题：这个念头或感受背后的来源(intention)是什么。<br><br>
    去感受那个来源。如果它是开阔的、积极的、让你更有能量、更有爱的，那它在往对的方向走。<br><br>
    读完之后，如果你不确定这些内容对你意味着什么，同样的方式：去感受它给你带来的是什么。如果它让你更积极、更打开、更有能量、更有爱，那它是适合你的，可以接收进来。<br><br>
    如果还是不确定，没关系。选择你的开阔状态认同的那条路，关掉这个页面就好，给时间时间。<br><br>
    这里没有宗教，没有包装，一切如是。我尽量做到这一点。如果你还是不确定，回到同一个问题：感受来源(intention)，感受你自己的来源，信任你的身体和感受。是宽还是窄，带着自己的觉察和选择继续。</p>
  </div>
  <div class="lang-block" data-lang="or">
    <!-- <h1>INTUITION</h1> -->
    <p> 在读以下任何内容之前，我希望你带着你自己的觉察，思考和感受。<br><br> 
    如果你的一些觉察和思考浮现出来，如果不确定，问自己一个问题，你的觉察和思考的来源 -- 这背后的intention是什么。<br>
    Reason on the intention (your intention), 如果这个来源是开阔的，积极的，打开的，让你更有能量，更好的，更有爱的，it means it's going in a right direction. <br><br>
    在读完我的内容后，留下来的感受和思考，如果你不确定，这些信息给你带来的影响是什么，reason on what it gives you，如果给你的(if you take it in)，也是走向更积极，更好，更有能量，更有爱，更打开的状态，this is for you, this can be taken in. <br><br>
    如果你还是不确定，没关系，这是路，选择你的开阔状态（源头）认同的路，给时间时间。<br><br>
    Note: 这里没有宗教，没有包装，一切如是, as it is. <br> 我尽量做到这一点，如果你不确定，again, reason on the intention, reason on your intention, trust your body and feelings，是宽是窄，带着自己的觉察，思考，感受和选择。</p>
  </div>
  <div class="lang-block" data-lang="en">
    <!-- <h1>INTUITION</h1> -->
    <p>Before you read anything here, I invite you to bring your own awareness, your own thinking, your own feeling.<br><br> 
    If something comes up as you read, a thought, a reaction, an uncertainty, ask yourself one question: where is this coming from? What is the intention behind it?<br><br>
    Sit with that source. If it feels open and loving, if it moves you toward something better, then it is going in the right direction. <br><br>
    After reading, if you are unsure what to make of something, use the same check: what does this give you, if you take it in? If it opens you up, gives you more energy, more love, more clarity, it is for you. You can let it in. <br><br>
    And if you are still not sure, that is okay. Choose the path you recognise, just close this tab, and give time the time. <br><br>
    There is no religion here, no packaging. Just things as they are. I try to keep it that way. If you are ever uncertain, come back to the same question: reason on the intention. Trust your body, trust what you feel. Notice whether it widens you or narrows you, and choose from there.</p>
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
