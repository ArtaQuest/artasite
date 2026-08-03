"use strict";

(function ($) {
  $(document).ready(function () {
    stm_nav_toggle();
    mobile_nav_trigger();
  });
  $(window).on('load', function () {
    $('.ms_lms_loader_bg_starter').fadeOut('fast');
    elementor_nav_toggle();
  });
  var stm_nav_toggle = function stm_nav_toggle() {
    $('.mobile-switcher').on('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      $(this).toggleClass('active');
      $(this).parent().toggleClass('active').find('.navigation-menu').toggleClass('active');
    });
    $('.menu-overlay').on('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      $(this).parent().find('.mobile-switcher').removeClass('active');
      $(this).parent().toggleClass('active').find('.menu').toggleClass('active');
    });
    $('.mobile-switcher .menu>li.menu-item-has-children').on('click', function () {
      var $this = $(this);
      if ($this.hasClass('active_sub_menu')) {
        $this.removeClass('active_sub_menu');
      } else {
        $('.navigation-menu .menu>li.menu-item-has-children').removeClass('active_sub_menu');
        $this.toggleClass('active_sub_menu');
        $this.parent().find('li .inner').slideUp(350);
      }
    });
    $('.menu-item-has-children').on('click', function () {
      var $this = $(this);
      if ($this.hasClass('active_sub_menu')) {
        $this.removeClass('active_sub_menu');
      } else {
        $('.navigation-menu .menu>li.menu-item-has-children').removeClass('active_sub_menu');
        $this.toggleClass('active_sub_menu');
      }
    });
  };
  var mobile_nav_trigger = function mobile_nav_trigger() {
    $(document).on('click', '.hfe-nav-menu__toggle', function (e) {
      e.preventDefault();
      e.stopPropagation();
      $('body').toggleClass('ms-lms-mobile-menu-active');
      var $header_height = $('#masthead').height();
      var newHeight = "calc(100vh - ".concat($header_height, "px)");
      $('body #masthead nav.menu-is-active.hfe-dropdown').css('height', newHeight);
    });
  };
  var elementor_nav_toggle = function stm_nav_toggle() {
    $('.hfe-nav-menu__layout-horizontal .hfe-nav-menu>.menu-item').on('click', function (e) {
      var $currentElement = $(this);
      $currentElement.removeClass('current-menu-ancestor-hide-line');
      $('.hfe-nav-menu__layout-horizontal .hfe-nav-menu > .menu-item').not($currentElement).each(function () {
        var $otherElement = $(this);
        $otherElement.removeClass('ms_lms_active_sub_menu');
        $('.hfe-nav-menu__layout-horizontal .hfe-nav-menu .menu-item .sub-menu > .menu-item').removeClass('ms_lms_active_sub_menu');
        if ($otherElement.find('.sub-menu.sub-menu-open').length > 0) {
          $otherElement.find('.hfe-has-submenu-container').removeClass('sub-menu-active');
          $otherElement.find('.sub-menu').removeClass('sub-menu-open').css({
            visibility: 'hidden',
            opacity: 0,
            height: 0
          });
        }
      });
      if ($currentElement.hasClass('ms_lms_active_sub_menu')) {
        $currentElement.removeClass('ms_lms_active_sub_menu');
      } else {
        $currentElement.addClass('ms_lms_active_sub_menu');
        $('.hfe-nav-menu__layout-horizontal .hfe-nav-menu .menu-item .sub-menu > .menu-item').each(function () {
          var $otherElement = $(this);
          if ($otherElement.find('.sub-menu.sub-menu-open').length > 0) {
            $otherElement.find('.hfe-has-submenu-container').removeClass('sub-menu-active');
            $otherElement.find('.sub-menu').removeClass('sub-menu-open').css({
              visibility: 'hidden',
              opacity: 0,
              height: 0
            });
          }
        });
      }
      e.stopPropagation();
    });
    $('.hfe-nav-menu__layout-horizontal .hfe-nav-menu .menu-item .sub-menu > .menu-item').on('click', function (e) {
      var $currentElement = $(this);
      var $parentMenuItem = $currentElement.closest('.hfe-nav-menu__layout-horizontal .hfe-nav-menu > .menu-item');
      var $parentMenuItemAncestor = $currentElement.closest('.hfe-nav-menu__layout-horizontal .hfe-nav-menu > .menu-item');
      if ($currentElement.is(':first-child')) {
        $parentMenuItemAncestor.toggleClass('current-menu-ancestor-hide-line');
      } else {
        $parentMenuItemAncestor.removeClass('current-menu-ancestor-hide-line');
      }
      $parentMenuItem.addClass('ms_lms_active_sub_menu');
      $('.hfe-nav-menu__layout-horizontal .hfe-nav-menu .menu-item .sub-menu > .menu-item').not($currentElement).each(function () {
        var $otherElement = $(this);
        $otherElement.removeClass('ms_lms_active_sub_menu');
        if ($otherElement.find('.sub-menu.sub-menu-open').length > 0) {
          $otherElement.find('.hfe-has-submenu-container').removeClass('sub-menu-active');
          $otherElement.find('.sub-menu').removeClass('sub-menu-open').css({
            visibility: 'hidden',
            opacity: 0,
            height: 0
          });
        }
      });
      if ($currentElement.hasClass('ms_lms_active_sub_menu')) {
        $currentElement.removeClass('ms_lms_active_sub_menu');
      } else {
        $currentElement.addClass('ms_lms_active_sub_menu');
      }
      e.stopPropagation();
    });
  };
})(jQuery);