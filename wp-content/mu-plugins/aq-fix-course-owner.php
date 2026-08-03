<?php
/**
 * Plugin Name: ArtaQuest — Defensive Course Owner Fix
 * Description: ArtaQuest LMS 4.x+ requires every stm-courses post to have a
 *              valid WP_User as owner. When a site is migrated between
 *              environments, the original author user ID may not exist on the
 *              target, causing a fatal "Cannot assign null to property
 *              CourseRepository::$owner". This plugin remaps orphaned courses
 *              to the first administrator on every page load (cheap query) and
 *              also runs once on init to fix existing data.
 */

if (!defined('ABSPATH')) { exit; }

/**
 * Return the first administrator user ID, or null if none.
 */
function ay_first_admin_user_id() {
    static $cached = null;
    if ($cached !== null) {
        return $cached ?: null;
    }
    $admins = get_users([
        'role'    => 'administrator',
        'number'  => 1,
        'orderby' => 'ID',
        'order'   => 'ASC',
        'fields'  => 'ID',
    ]);
    $cached = !empty($admins) ? (int) $admins[0] : 0;
    return $cached ?: null;
}

/**
 * One-shot repair on init: walk every stm-courses post and reassign authorship
 * if the current post_author does not resolve to a real WP_User.
 */
add_action('init', function () {
    if (get_option('ay_course_owner_fix_done')) return;

    $fallback = ay_first_admin_user_id();
    if (!$fallback) return; // nothing we can do

    global $wpdb;
    $course_ids = $wpdb->get_col(
        "SELECT ID FROM $wpdb->posts WHERE post_type = 'stm-courses'"
    );
    if (!$course_ids) {
        update_option('ay_course_owner_fix_done', 1);
        return;
    }

    $fixed = 0;
    foreach ($course_ids as $cid) {
        $author_id = (int) get_post_field('post_author', $cid);
        if (!$author_id || !get_userdata($author_id)) {
            wp_update_post([
                'ID'          => $cid,
                'post_author' => $fallback,
            ]);
            $fixed++;
        }
    }

    if ($fixed > 0) {
        error_log("ay_course_owner_fix: reassigned $fixed orphaned course(s) to user $fallback");
    }
    update_option('ay_course_owner_fix_done', 1);
}, 5); // priority 5 — runs BEFORE ArtaQuest's wp_head hooks that trip the fatal

/**
 * Safety net: if ArtaQuest's CourseRepository->find() is about to be called
 * with a course whose author is orphaned, silently fix the row first. This
 * prevents the fatal during the very same request that exposed the bad state.
 *
 * Performance: only arm once-per-request, and only on requests touching the
 * `stm-courses` post type. Skipped entirely on REST/AJAX/admin/static pages
 * once `ay_course_owner_fix_done` is set.
 */
add_filter('the_posts', function ($posts, $query) {
    if (empty($posts) || !is_array($posts)) return $posts;
    // Once the one-shot repair has flagged itself as done, we can be more
    // selective — only enter the loop when at least one of the posts is a
    // stm-courses row.
    if (get_option('ay_course_owner_fix_done')) {
        $has_course = false;
        foreach ($posts as $p) {
            if (isset($p->post_type) && $p->post_type === 'stm-courses') {
                $has_course = true; break;
            }
        }
        if (!$has_course) return $posts;
    }
    $fallback = ay_first_admin_user_id();
    if (!$fallback) return $posts;

    foreach ($posts as $p) {
        if (isset($p->post_type) && $p->post_type === 'stm-courses') {
            $author_id = (int) $p->post_author;
            if (!$author_id || !get_userdata($author_id)) {
                global $wpdb;
                $wpdb->update(
                    $wpdb->posts,
                    ['post_author' => $fallback],
                    ['ID' => (int) $p->ID]
                );
                clean_post_cache((int) $p->ID);
                $p->post_author = (string) $fallback;
            }
        }
    }
    return $posts;
}, 1, 2);

/**
 * Belt-and-suspenders: when ArtaQuest calls get_post() internally during a
 * page-render hook (e.g. artaquest_course_header_meta_data), a freshly-read
 * post may still have a stale post_author. Patch the post object on the fly.
 */
add_filter('the_post', function ($post) {
    if (isset($post->post_type) && $post->post_type === 'stm-courses') {
        $author_id = (int) $post->post_author;
        if (!$author_id || !get_userdata($author_id)) {
            $fallback = ay_first_admin_user_id();
            if ($fallback) {
                $post->post_author = (string) $fallback;
            }
        }
    }
    return $post;
}, 1);

/**
 * Strip "woocommerce-placeholder" auto-pages from the navigation menu output.
 * WooCommerce / WordPress.com auto-setup can insert a placeholder page named
 * "woocommerce-placeholder" into the primary menu on first activation. We
 * never want it visible to visitors. Filter at render time so the menu stays
 * clean regardless of what's in the DB.
 */
add_filter('wp_nav_menu_objects', function ($items, $args) {
    if (!is_array($items)) return $items;
    return array_values(array_filter($items, function ($item) {
        // Reject by URL slug
        if (!empty($item->url) && stripos($item->url, 'woocommerce-placeholder') !== false) {
            return false;
        }
        // Reject by visible title
        $title = isset($item->title) ? (string) $item->title : '';
        if (stripos($title, 'woocommerce-placeholder') !== false ||
            stripos($title, 'woocommerce placeholder') !== false) {
            return false;
        }
        // Reject by linked post slug
        if (!empty($item->object_id) && !empty($item->object) && $item->object === 'page') {
            $slug = get_post_field('post_name', (int) $item->object_id);
            if ($slug && stripos($slug, 'woocommerce-placeholder') !== false) {
                return false;
            }
        }
        return true;
    }));
}, 10, 2);
